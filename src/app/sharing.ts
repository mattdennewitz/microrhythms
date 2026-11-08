/* Share the same versioned state as project files, without a server. */
import { project } from '../core/project';
import { encodeShare, decodeShare, MAX_SHARE_URL_LENGTH } from '../core/share-codec';
import { flight } from '../core/flight';
import { subscribe } from './store';

const THROTTLE_MS = 500;
let timer: number | undefined;
let generation = 0;
let lastJson = '';
let report: (message: string) => void;
let restoring = false;
let restoreAbort: AbortController | undefined;
let syncBusy = false;

function baseUrl(): URL {
  const url = new URL(location.href);
  url.hash = '';
  return url;
}

function replaceHash(hash: string) {
  const url = baseUrl();
  url.hash = hash;
  if (hash && url.href.length > MAX_SHARE_URL_LENGTH) throw new Error('Share URL is too large; use project file export instead.');
  window.history.replaceState(window.history.state, '', url);
  return url.href;
}

async function sync() {
  timer = undefined;
  if (restoring) return;
  if (syncBusy) {
    timer = window.setTimeout(() => { void sync(); }, THROTTLE_MS);
    return;
  }
  syncBusy = true;
  const current = generation;
  let json = '';
  try {
    const snapshot = project.serialize();
    json = JSON.stringify(snapshot);
    if (json === lastJson) return;
    const hash = await encodeShare(snapshot, MAX_SHARE_URL_LENGTH - baseUrl().href.length);
    if (current !== generation) return;
    replaceHash(hash);
    lastJson = json;
  } catch (err) {
    if (current !== generation) return;
    // A previous setup's link must not masquerade as the current one.
    replaceHash('');
    lastJson = json;
    report(`URL not updated: ${(err as Error).message}`);
  } finally {
    syncBusy = false;
  }
}

function schedule() {
  if (restoring) return;
  generation++;
  if (timer === undefined) timer = window.setTimeout(() => { void sync(); }, THROTTLE_MS);
}

export const sharing = {
  /** Restore before mounting React or starting animation/audio. */
  async init(onMessage: (message: string) => void) {
    report = onMessage;
    const restore = async () => {
      restoreAbort?.abort();
      const controller = new AbortController();
      restoreAbort = controller;
      const current = ++generation;
      restoring = true;
      clearTimeout(timer);
      timer = undefined;
      const hash = location.hash;
      let shouldSync = false;
      try {
        if (!hash) {
          lastJson = '';
          shouldSync = true;
          return;
        }
        const saved = await decodeShare(hash, MAX_SHARE_URL_LENGTH - baseUrl().href.length, controller.signal);
        if (current !== generation || location.hash !== hash) return;
        project.apply(saved);
        lastJson = '';
        shouldSync = true;
        report('shared setup loaded — press play');
      } catch (err) {
        if (current !== generation || controller.signal.aborted) return;
        // A rejected link never replaces the current setup, playback or sounds.
        replaceHash('');
        lastJson = '';
        report(`share link rejected: ${(err as Error).message} — current setup unchanged`);
      } finally {
        if (current === generation) {
          restoring = false;
          restoreAbort = undefined;
          if (shouldSync) schedule();
        }
      }
    };
    const unsubscribe = subscribe(schedule);
    window.addEventListener('hashchange', restore);
    // Flight position changes outside React's notification stream.
    const flightTimer = setInterval(() => { if (flight.on) schedule(); }, THROTTLE_MS);
    await restore();
    return () => {
      generation++;
      restoreAbort?.abort();
      restoreAbort = undefined;
      restoring = false;
      clearTimeout(timer);
      timer = undefined;
      clearInterval(flightTimer);
      unsubscribe();
      window.removeEventListener('hashchange', restore);
    };
  },
  /** Capture at the click, not at the last throttled update. */
  async link(): Promise<string> {
    if (restoring) throw new Error('share link is still loading');
    const current = ++generation;
    const snapshot = project.serialize();
    const json = JSON.stringify(snapshot);
    const url = baseUrl();
    const hash = await encodeShare(snapshot, MAX_SHARE_URL_LENGTH - url.href.length);
    url.hash = hash;
    if (current === generation) {
      replaceHash(hash);
      lastJson = json;
    }
    return url.href;
  },

  async copy(): Promise<void> {
    if (!navigator.clipboard) throw new Error('clipboard unavailable — copy the URL from the address bar');
    // A promised ClipboardItem retains the click's user activation in WebKit,
    // even though compression finishes asynchronously.
    const link = this.link();
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': link.then((url) => new Blob([url], { type: 'text/plain' })),
        })]);
      } else {
        await navigator.clipboard.writeText(await link);
      }
    } catch {
      // Preserve encoding errors; a successful link remains available when
      // clipboard permission is denied.
      await link;
      throw new Error('clipboard access denied — copy the URL from the address bar');
    }
  },
};

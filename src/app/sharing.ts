/* Share the same versioned state as project files, without a server. */
import { project } from '../core/project';
import { encodeShare, decodeShare } from '../core/share-codec';
import { flight } from '../core/flight';
import { subscribe } from './store';

const THROTTLE_MS = 500;
let timer: number | undefined;
let generation = 0;
let lastJson = '';
let report: (message: string) => void;
let restoring = false;

function replaceHash(hash: string) {
  const url = new URL(location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, '', url);
  return url.href;
}

async function sync() {
  timer = undefined;
  const current = generation;
  const snapshot = project.serialize();
  const json = JSON.stringify(snapshot);
  if (json === lastJson) return;
  try {
    const hash = await encodeShare(snapshot);
    if (current !== generation) return;
    replaceHash(hash);
    lastJson = json;
  } catch (err) {
    if (current !== generation) return;
    // A previous setup's link must not masquerade as the current one.
    replaceHash('');
    lastJson = json;
    report(`URL not updated: ${(err as Error).message}`);
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
    const defaults = project.serialize();
    const restore = async () => {
      const current = ++generation;
      restoring = true;
      clearTimeout(timer);
      timer = undefined;
      const hash = location.hash;
      try {
        const saved = hash ? await decodeShare(hash) : defaults;
        if (current !== generation) return;
        project.apply(saved);
        lastJson = '';
        if (hash) report('shared setup loaded — press play');
      } catch (err) {
        if (current !== generation) return;
        // Decode/validation completes before apply, so bad links never partially load.
        project.apply(defaults);
        lastJson = '';
        report(`could not load share link: ${(err as Error).message} — using defaults`);
      }
      restoring = false;
      schedule();
    };
    await restore();
    const unsubscribe = subscribe(schedule);
    window.addEventListener('hashchange', restore);
    // Flight position changes outside React's notification stream.
    const flightTimer = setInterval(() => { if (flight.on) schedule(); }, THROTTLE_MS);
    return () => {
      generation++;
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
    const hash = await encodeShare(snapshot);
    const url = new URL(location.href);
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

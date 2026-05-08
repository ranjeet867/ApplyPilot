/**
 * ApplyPilot — MV3 Background Service Worker  (v1.2)
 *
 * New in v1.1:
 *  • OPEN_AND_APPLY  — open tab + auto-trigger fill panel
 *  • QUEUE_START / QUEUE_ADVANCE / QUEUE_SKIP / QUEUE_CLEAR — batch apply queue
 *  • SAVE_COVER_LETTER — persist generated letter back to the Job record
 *  • TOGGLE_PANEL     — forwarded from keyboard shortcut to active tab
 *  • chrome.commands  — Alt+Shift+A → toggle panel
 *
 * New in v1.2:
 *  • Stuck detection — if the queue tab hasn't advanced in STUCK_TIMEOUT_MS,
 *    capture a screenshot, ask Haiku to diagnose, attempt a CSS-selector click,
 *    or abort and mark the job as failed then advance the queue.
 */

import type {
  ExtensionMessage,
  Job,
  ExtractedJob,
  CoverLetterPayload,
  QueueState,
  QueueStartPayload,
  TriggerPanelPayload,
} from '../types';
import {
  getSettings,
  saveSettings,
  saveJob,
  saveJobs,
  getAllJobs,
  findJobByUrl,
  findSimilarJobs,
  updateJobStatus,
  generateId,
  getQueue,
  saveQueue,
  clearQueue,
} from '../shared/storage';
import { generateCoverLetter } from '../shared/api';
import { getDomain } from '../shared/utils';
import { getResume as getResumeFromIDB } from '../shared/db';

// ── Pending panel triggers (tabId → queue info) ───────────────────────────────
const pendingTriggers = new Map<number, TriggerPanelPayload>();

// ── Stuck-detection timers (tabId → timeoutId) ────────────────────────────────
const stuckTimers   = new Map<number, ReturnType<typeof setTimeout>>();
const STUCK_TIMEOUT_MS = 45_000; // 45 s without queue advance → diagnose

// ── Install / startup ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);

// ── Keyboard shortcut: Alt+Shift+A → toggle panel ────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }).catch(() => {});
      }
    });
  }
});

// ── Tab tracking ──────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const url = tab.url;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  // Mark job as opened
  const job = await findJobByUrl(url);
  if (job && job.status === 'new') {
    await updateJobStatus(job.id, 'opened');
    await refreshBadge();
  }

  // Fire pending panel trigger (OPEN_AND_APPLY or queue)
  if (pendingTriggers.has(tabId)) {
    const payload = pendingTriggers.get(tabId)!;
    setTimeout(() => sendTriggerWithRetry(tabId, payload, 3), 600);
  }
});

/** Send TRIGGER_PANEL with up to `retries` retries on failure. */
function sendTriggerWithRetry(tabId: number, payload: TriggerPanelPayload, retries: number) {
  chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_PANEL', payload }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      if (retries > 0) {
        setTimeout(() => sendTriggerWithRetry(tabId, payload, retries - 1), 800);
      }
    } else {
      pendingTriggers.delete(tabId);
      // Start stuck-detection timer if this tab is the active queue tab
      if (payload.queuePos !== undefined) {
        armStuckTimer(tabId);
      }
    }
  });
}

// ── Tab removal: clean up pending triggers and timers ─────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTriggers.delete(tabId);
  clearStuckTimer(tabId);
});

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender, sendResponse);
    return true;
  },
);

async function handleMessage(
  message: ExtensionMessage,
  sender:  chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) {
  try {
    switch (message.type) {

      // ── Jobs extracted from Gmail / LinkedIn ──────────────────────────────
      case 'JOBS_EXTRACTED': {
        const extracted = message.payload as ExtractedJob[];
        const jobs: Job[] = extracted.map((e) => ({
          id:           generateId(),
          title:        e.title,
          company:      e.company,
          location:     e.location,
          applyUrl:     e.applyUrl,
          sourceUrl:    e.sourceUrl,
          sourceDomain: getDomain(e.sourceUrl),
          status:       'new',
          notes:        '',
          savedAt:      Date.now(),
          postedDate:   e.postedDate,
          salary:       e.salary,
          remote:       e.remote,
        }));
        const result = await saveJobs(jobs);
        await refreshBadge();
        respond({ ok: true, ...result });
        break;
      }

      // ── Check duplicate URL + fuzzy match ────────────────────────────────
      case 'CHECK_DUPLICATE_URL': {
        const payload = message.payload as string | { url: string; company?: string; title?: string };
        const url     = typeof payload === 'string' ? payload : payload.url;
        const company = typeof payload === 'string' ? '' : (payload.company ?? '');
        const title   = typeof payload === 'string' ? '' : (payload.title ?? '');
        const job     = await findJobByUrl(url);
        const similar = (company || title) ? await findSimilarJobs(company, title, url) : [];
        respond({ found: !!job, job: job ?? null, similar: similar.slice(0, 3) });
        break;
      }

      // ── Settings ──────────────────────────────────────────────────────────
      case 'GET_SETTINGS': {
        respond(await getSettings());
        break;
      }

      // ── All jobs ──────────────────────────────────────────────────────────
      case 'GET_JOBS': {
        respond(await getAllJobs());
        break;
      }

      // ── Mark opened ───────────────────────────────────────────────────────
      case 'MARK_JOB_OPENED': {
        const url = message.payload as string;
        const job = await findJobByUrl(url);
        if (job && job.status === 'new') await updateJobStatus(job.id, 'opened');
        respond({ ok: true });
        break;
      }

      // ── AI cover letter ───────────────────────────────────────────────────
      case 'GENERATE_COVER_LETTER': {
        const payload  = message.payload as CoverLetterPayload;
        const settings = await getSettings();
        try {
          const letter = await generateCoverLetter(payload, settings);
          respond({ ok: true, letter });
        } catch (err) {
          respond({ ok: false, error: (err as Error).message });
        }
        break;
      }

      // ── Save cover letter back to job record ─────────────────────────────
      case 'SAVE_COVER_LETTER': {
        const { jobUrl, letter } = message.payload as { jobUrl: string; letter: string };
        const job = await findJobByUrl(jobUrl);
        if (job) {
          await updateJobStatus(job.id, job.status, { coverLetter: letter } as Partial<Job>);
        }
        respond({ ok: true });
        break;
      }

      // ── Open options ──────────────────────────────────────────────────────
      case 'OPEN_OPTIONS': {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        respond({ ok: true });
        break;
      }

      // ── Open tab + auto-trigger fill panel ────────────────────────────────
      case 'OPEN_AND_APPLY': {
        const { jobUrl } = message.payload as { jobUrl: string };
        const tab = await chrome.tabs.create({ url: jobUrl, active: true });
        if (tab.id) {
          pendingTriggers.set(tab.id, { autoFill: false });
        }
        respond({ ok: true, tabId: tab.id });
        break;
      }

      // ── Queue: start batch apply ──────────────────────────────────────────
      case 'QUEUE_START': {
        const { jobIds, autoMode } = message.payload as QueueStartPayload;
        if (jobIds.length === 0) { respond({ ok: false, error: 'No jobs selected' }); break; }

        const state: QueueState = { jobIds, current: 0, active: true, autoMode: autoMode ?? false };
        await saveQueue(state);
        await openQueueJob(state);
        respond({ ok: true, total: jobIds.length });
        break;
      }

      // ── Queue: advance to next ────────────────────────────────────────────
      case 'QUEUE_ADVANCE': {
        const { markApplied, tabId } = message.payload as { markApplied: boolean; tabId?: number };
        const state = await getQueue();
        if (!state?.active) { respond({ ok: false, error: 'No active queue' }); break; }

        // Disarm stuck timer — the user manually advanced
        if (tabId) clearStuckTimer(tabId);

        if (markApplied) {
          const jobs = await getAllJobs();
          const currentJobId = state.jobIds[state.current];
          const job = jobs.find((j) => j.id === currentJobId);
          if (job) await updateJobStatus(job.id, 'applied', { appliedAt: Date.now() });
          await refreshBadge();
        }

        const next = state.current + 1;
        if (next >= state.jobIds.length) {
          await clearQueue();
          const tid = tabId ?? state.tabId;
          if (tid) {
            chrome.tabs.sendMessage(tid, {
              type: 'TRIGGER_PANEL',
              payload: { queuePos: state.jobIds.length, queueTotal: state.jobIds.length, done: true },
            }).catch(() => {});
          }
          respond({ ok: true, done: true });
        } else {
          const newState: QueueState = { ...state, current: next, tabId };
          await saveQueue(newState);
          await openQueueJob(newState);
          respond({ ok: true, done: false, next });
        }
        break;
      }

      // ── Queue: skip current ───────────────────────────────────────────────
      case 'QUEUE_SKIP': {
        const { tabId: skipTabId } = message.payload as { tabId?: number };
        const state = await getQueue();
        if (!state?.active) { respond({ ok: false, error: 'No active queue' }); break; }

        if (skipTabId) clearStuckTimer(skipTabId);

        const next = state.current + 1;
        if (next >= state.jobIds.length) {
          await clearQueue();
          respond({ ok: true, done: true });
        } else {
          const newState: QueueState = { ...state, current: next, tabId: skipTabId };
          await saveQueue(newState);
          await openQueueJob(newState);
          respond({ ok: true, done: false, next });
        }
        break;
      }

      // ── Queue: get current state ──────────────────────────────────────────
      case 'QUEUE_GET_STATE': {
        respond(await getQueue());
        break;
      }

      // ── Queue: abort ──────────────────────────────────────────────────────
      case 'QUEUE_CLEAR': {
        // Clear all stuck timers
        for (const [tid] of stuckTimers) clearStuckTimer(tid);
        await clearQueue();
        respond({ ok: true });
        break;
      }

      // ── Iframe ↔ top-frame field relay ────────────────────────────────────
      case 'IFRAME_FIELDS_DETECTED': {
        // Iframe content script detected fields — relay to the top frame (frameId 0)
        const tabId2 = sender.tab?.id;
        const srcFrame = sender.frameId ?? 0;
        if (!tabId2 || srcFrame === 0) { respond({ ok: false }); break; }
        try {
          await chrome.tabs.sendMessage(tabId2, {
            type: 'IFRAME_FIELDS_DETECTED',
            payload: { ...(message.payload as object), iframeFrameId: srcFrame },
          }, { frameId: 0 });
        } catch (e) {
          console.warn('[ApplyPilot] Failed to relay iframe fields to top frame:', e);
        }
        respond({ ok: true });
        break;
      }

      case 'FILL_IFRAME_FIELDS': {
        // Top frame wants iframe to fill — relay to the correct iframe
        const tabId3 = sender.tab?.id;
        const targetFrame = (message.payload as any)?.iframeFrameId;
        if (!tabId3 || !targetFrame) { respond({ ok: false }); break; }
        try {
          await chrome.tabs.sendMessage(tabId3, {
            type: 'FILL_IFRAME_FIELDS',
          }, { frameId: targetFrame });
        } catch (e) {
          console.warn('[ApplyPilot] Failed to relay fill to iframe:', e);
        }
        respond({ ok: true });
        break;
      }

      // ── Inject file into page's main world (bypasses content-script realm) ──
      case 'INJECT_FILE_MAIN_WORLD': {
        const p = message.payload as {
          name: string; ftype: string; dataUrl: string; inputIndex?: number;
        };
        const tabId = sender.tab?.id;
        const frameId = sender.frameId ?? 0;
        if (!tabId) { respond({ ok: false, error: 'No tab ID' }); break; }

        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: 'MAIN',
            args: [p.name, p.ftype, p.dataUrl, p.inputIndex ?? -1],
            func: (fileName: string, fileType: string, dataUrl: string, targetIndex: number) => {
              try {
                // Reconstruct File in the PAGE's JS realm (same realm as React)
                const parts = dataUrl.split(',');
                const mime = parts[0].match(/:(.*?);/)?.[1] ?? fileType;
                const bstr = atob(parts[1]);
                const bytes = new Uint8Array(bstr.length);
                for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
                const file = new File(
                  [new Blob([bytes], { type: mime })],
                  fileName,
                  { type: mime, lastModified: Date.now() },
                );
                const dt = new DataTransfer();
                dt.items.add(file);

                // Helper: set files on an input and fire events
                function injectFiles(el: HTMLInputElement) {
                  if (!el) return;
                  try {
                    const setter = Object.getOwnPropertyDescriptor(
                      HTMLInputElement.prototype, 'files',
                    )?.set;
                    if (setter) setter.call(el, dt.files);
                    else Object.defineProperty(el, 'files', {
                      value: dt.files, writable: true, configurable: true,
                    });
                  } catch { /* ignore */ }
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }

                // Helper: fire drag sequence on a dropzone
                function fireDrop(dz: HTMLElement) {
                  if (!dz) return;
                  const mk = (n: string) => new DragEvent(n, {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                  });
                  dz.dispatchEvent(mk('dragenter'));
                  dz.dispatchEvent(mk('dragover'));
                  dz.dispatchEvent(mk('drop'));
                  setTimeout(() => {
                    const fi = dz.querySelector<HTMLInputElement>('input[type="file"]');
                    if (fi) injectFiles(fi);
                  }, 200);
                }

                // Walk up from an element to find the react-dropzone container
                function findDropzone(el: HTMLElement): HTMLElement | null {
                  let p: HTMLElement | null = el.parentElement;
                  while (p && p !== document.body) {
                    if (p.hasAttribute('tabindex')) {
                      const r = p.getBoundingClientRect();
                      if (r.width > 80 && r.height > 30) return p;
                    }
                    const fiberKey = Object.keys(p).find(
                      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
                    );
                    if (fiberKey) {
                      let fiber = (p as any)[fiberKey];
                      for (let i = 0; i < 10 && fiber; i++) {
                        if (fiber.memoizedProps?.onDrop || fiber.pendingProps?.onDrop) {
                          return p;
                        }
                        fiber = fiber.return;
                      }
                    }
                    const cls = (p.className || '').toLowerCase();
                    const tid = (p.getAttribute('data-testid') || '').toLowerCase();
                    if (/dropzone|drop.zone|file.?upload|upload.?area|drag.?drop/i.test(cls + ' ' + tid)) {
                      return p;
                    }
                    p = p.parentElement;
                  }
                  return null;
                }

                // Alternative: directly invoke React's onDrop via fiber
                function tryReactFiberDrop(dz: HTMLElement): boolean {
                  const fiberKey = Object.keys(dz).find(
                    (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
                  );
                  if (!fiberKey) return false;
                  let fiber = (dz as any)[fiberKey];
                  for (let i = 0; i < 15 && fiber; i++) {
                    const props = fiber.memoizedProps || fiber.pendingProps;
                    if (props?.onDrop) {
                      try {
                        props.onDrop({
                          dataTransfer: dt,
                          preventDefault: () => {},
                          stopPropagation: () => {},
                          persist: () => {},
                          nativeEvent: new DragEvent('drop', {
                            bubbles: true, cancelable: true, dataTransfer: dt,
                          }),
                        });
                        return true;
                      } catch { /* fall through */ }
                    }
                    fiber = fiber.return;
                  }
                  return false;
                }

                // Inject into targeted input only (or all resume-like inputs as fallback)
                const allInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');

                if (targetIndex >= 0 && targetIndex < allInputs.length) {
                  // Targeted mode: only inject into the specific input
                  const inp = allInputs[targetIndex];
                  injectFiles(inp);
                  const dz = findDropzone(inp);
                  if (dz) {
                    if (!tryReactFiberDrop(dz)) fireDrop(dz);
                  }
                } else {
                  // Legacy fallback: inject into all resume-like inputs
                  allInputs.forEach((inp) => {
                    const accept = (inp.accept || '').toLowerCase();
                    const nameId = ((inp.name || '') + (inp.id || '')).toLowerCase();
                    const isResume = /pdf|doc|resume|cv/i.test(accept + nameId) ||
                      accept === '' || /application/i.test(accept);
                    if (isResume) {
                      injectFiles(inp);
                      const dz = findDropzone(inp);
                      if (dz) {
                        if (!tryReactFiberDrop(dz)) fireDrop(dz);
                      }
                    }
                  });
                }

                console.log('[ApplyPilot MAIN] File injected via main-world:', fileName,
                  targetIndex >= 0 ? `(input #${targetIndex})` : '(all inputs)');
              } catch (e) {
                console.warn('[ApplyPilot MAIN] Error:', e);
              }
            },
          });
          respond({ ok: true });
        } catch (err) {
          respond({ ok: false, error: (err as Error).message });
        }
        break;
      }

      // ── Recover resume binary from IndexedDB (content scripts can't access ext IDB) ──
      case 'GET_RESUME_FROM_IDB': {
        try {
          const record = await getResumeFromIDB();
          if (record?.dataUrl) {
            console.log('[ApplyPilot BG] Recovered resume from IndexedDB:',
              record.fileName, '| dataUrl length:', record.dataUrl.length);
            // Auto-repair: persist back to chrome.storage.local so future loads are fast
            await saveSettings({
              resumeDataUrl:  record.dataUrl,
              resumeFileName: record.fileName,
              resumeText:     record.text || '',
            });
            console.log('[ApplyPilot BG] Auto-repaired chrome.storage.local with IDB resume data');
            respond({
              ok:       true,
              dataUrl:  record.dataUrl,
              fileName: record.fileName,
              mimeType: record.mimeType,
              text:     record.text || '',
            });
          } else {
            console.log('[ApplyPilot BG] No resume found in IndexedDB either.');
            respond({ ok: false, error: 'No resume in IndexedDB' });
          }
        } catch (err) {
          console.warn('[ApplyPilot BG] IndexedDB recovery failed:', err);
          respond({ ok: false, error: (err as Error).message });
        }
        break;
      }

      default:
        respond({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  } catch (err) {
    respond({ ok: false, error: (err as Error).message });
  }
}

// ── Queue: open the current job in a tab ──────────────────────────────────────

async function openQueueJob(state: QueueState) {
  const jobs     = await getAllJobs();
  const jobId    = state.jobIds[state.current];
  const job      = jobs.find((j) => j.id === jobId);
  if (!job) return;

  const settings = await getSettings();

  // ── Pre-generate cover letter via Haiku before opening the tab ───────────
  let coverLetter = job.coverLetter ?? '';   // reuse saved letter if exists
  if (!coverLetter && (settings.anthropicApiKey || settings.openaiApiKey)) {
    try {
      coverLetter = await generateCoverLetter(
        {
          jobTitle:       job.title,
          company:        job.company,
          location:       job.location,
          jobDescription: job.description || `${job.title} at ${job.company} — ${job.location}`,
          resumeText:     settings.resumeText,
          profile:        settings.profile,
        },
        settings,
      );
      // Persist the generated letter back to the job record
      if (coverLetter) {
        await updateJobStatus(job.id, job.status, { coverLetter } as Partial<Job>);
      }
    } catch (e) {
      console.warn('[ApplyPilot] Cover letter pre-generation failed:', (e as Error).message);
    }
  }

  const payload: TriggerPanelPayload = {
    queuePos:    state.current + 1,
    queueTotal:  state.jobIds.length,
    autoFill:    true,
    autoMode:    state.autoMode,
    coverLetter: coverLetter || undefined,
    jobTitle:    job.title,
    company:     job.company,
  };

  // Open applyUrl; fall back to sourceUrl if applyUrl looks like it's a listing page
  const targetUrl = job.applyUrl || job.sourceUrl;

  if (state.tabId) {
    try {
      await chrome.tabs.update(state.tabId, { url: targetUrl, active: true });
      pendingTriggers.set(state.tabId, payload);
    } catch {
      const tab = await chrome.tabs.create({ url: targetUrl, active: true });
      if (tab.id) {
        await saveQueue({ ...state, tabId: tab.id });
        pendingTriggers.set(tab.id, payload);
      }
    }
  } else {
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    if (tab.id) {
      await saveQueue({ ...state, tabId: tab.id });
      pendingTriggers.set(tab.id, payload);
    }
  }
}

// ── Stuck detection ───────────────────────────────────────────────────────────

function armStuckTimer(tabId: number) {
  clearStuckTimer(tabId); // reset if already armed
  const id = setTimeout(() => handleStuckTab(tabId), STUCK_TIMEOUT_MS);
  stuckTimers.set(tabId, id);
}

function clearStuckTimer(tabId: number) {
  const id = stuckTimers.get(tabId);
  if (id !== undefined) { clearTimeout(id); stuckTimers.delete(tabId); }
}

/**
 * Called when a queue tab hasn't advanced in STUCK_TIMEOUT_MS.
 * 1. Capture a screenshot
 * 2. Ask Haiku: "what should I click to proceed, or ABORT?"
 * 3. If a CSS selector is returned → send CLICK_SELECTOR to content script
 * 4. If ABORT (or click fails) → mark job failed, advance queue
 */
async function handleStuckTab(tabId: number) {
  stuckTimers.delete(tabId);

  const state = await getQueue();
  if (!state?.active || state.tabId !== tabId) return;

  let screenshotDataUrl: string | null = null;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(
      undefined,                        // current window
      { format: 'jpeg', quality: 60 },  // compressed to keep payload small
    );
  } catch {
    // If capture fails (e.g. tab is internal), just abort this job
    await abortAndAdvance(state, tabId, 'Screenshot capture failed');
    return;
  }

  // Get current tab URL for context
  let tabUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url ?? '';
  } catch { /* ignore */ }

  // Ask Haiku to diagnose
  const settings = await getSettings();
  const apiKey   = settings.anthropicApiKey;
  if (!apiKey) {
    await abortAndAdvance(state, tabId, 'No API key — cannot diagnose');
    return;
  }

  const diagnosisPrompt = `You are an expert at filling out job application forms on behalf of a job seeker.
The automated tool is stuck on this page and has not been able to proceed.
Page URL: ${tabUrl}

Look at the screenshot carefully and respond with EXACTLY ONE of:
1. A valid CSS selector string (e.g. "button[type=submit]") that should be clicked to advance the form.
2. The word ABORT if the page requires human intervention (CAPTCHA, login wall, completely unrecognised form, error state that cannot be auto-resolved).

Respond with ONLY the CSS selector or the word ABORT. No other text.`;

  let diagnosis = 'ABORT';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        thinking: { type: 'enabled', budget_tokens: 128 },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: screenshotDataUrl.split(',')[1] },
            },
            { type: 'text', text: diagnosisPrompt },
          ],
        }],
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      const raw  = (data.content ?? [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text.trim())
        .join('')
        .trim();
      diagnosis = raw || 'ABORT';
    }
  } catch { /* network error → abort */ }

  if (diagnosis === 'ABORT') {
    await abortAndAdvance(state, tabId, 'AI diagnosis: ABORT');
    return;
  }

  // Try clicking the suggested selector via the content script
  chrome.tabs.sendMessage(tabId, { type: 'CLICK_SELECTOR', payload: { selector: diagnosis } }, async (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      await abortAndAdvance(state, tabId, `Selector click failed: ${diagnosis}`);
    } else {
      // Re-arm the stuck timer — the click was made, give it more time
      armStuckTimer(tabId);
    }
  });
}

async function abortAndAdvance(state: QueueState, tabId: number, reason: string) {
  // Mark current job as failed
  const jobs = await getAllJobs();
  const jobId = state.jobIds[state.current];
  const job   = jobs.find((j) => j.id === jobId);
  if (job) {
    await updateJobStatus(job.id, 'failed', {
      notes: (job.notes ? job.notes + '\n' : '') + `[AutoApply] ${reason}`,
    } as Partial<Job>);
  }
  await refreshBadge();

  // Show a brief notification in the stuck tab
  chrome.tabs.sendMessage(tabId, {
    type: 'TRIGGER_PANEL',
    payload: { stuckAbort: true, reason },
  }).catch(() => {});

  // Advance the queue (don't mark as applied)
  const next = state.current + 1;
  if (next >= state.jobIds.length) {
    await clearQueue();
    chrome.tabs.sendMessage(tabId, {
      type: 'TRIGGER_PANEL',
      payload: { queuePos: state.jobIds.length, queueTotal: state.jobIds.length, done: true },
    }).catch(() => {});
  } else {
    const newState: QueueState = { ...state, current: next, tabId };
    await saveQueue(newState);
    // Small delay so the user can see the abort message
    setTimeout(() => openQueueJob(newState), 2500);
  }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

async function refreshBadge() {
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
      return;
    }
    const jobs     = await getAllJobs();
    const newCount = jobs.filter((j) => j.status === 'new').length;
    const text     = newCount > 0 ? String(Math.min(newCount, 99)) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
  } catch { /* storage not ready */ }
}

// Listen for settings changes to update badge immediately
chrome.storage.onChanged.addListener((changes) => {
  if (changes['ap_settings']) refreshBadge();
});

chrome.alarms.create('badge_refresh', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge_refresh') refreshBadge();
});

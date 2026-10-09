import { editor } from "./common.ts";
import { updateCustomGitGutter } from "./git_gutter.ts";
import { refreshJavaBuffer } from "./syntax_java.ts";
import { refreshXmlBuffer } from "./syntax_xml.ts";
import { refreshYamlBuffer } from "./syntax_yaml.ts";
import { refreshPropertiesBuffer } from "./syntax_properties.ts";

// ---------------------------------------------------------------------------
// Unified Buffer Visuals Dispatcher (debounced + in-flight coalesced)
// ---------------------------------------------------------------------------

/** Collapse keystroke / scroll bursts into one visuals pass this long after
 *  the last request. */
const VISUALS_DEBOUNCE_MS = 120;

interface VisualRequest {
  /** Whether this pass should also refresh the git gutter (a git diff spawn). */
  gutter: boolean;
  /** Buffer version from `lines_changed`, when known. Lets an unchanged buffer
   *  skip the whole-buffer rescan entirely (scrolling reveals new lines but
   *  does not change the version). `null` forces a rescan. */
  epoch: number | null;
}

const visualsQueue = new Map<number, VisualRequest>();
const visualsInFlight = new Set<number>();
const visualsPendingAgain = new Set<number>();
const lastScannedEpoch = new Map<number, number>();
let visualsTimer: number | null = null;

/** Queue a visuals refresh for `bufferId`. Bursts coalesce into a single pass
 *  `VISUALS_DEBOUNCE_MS` after the last request, and `epoch` (from
 *  `lines_changed`) lets an unchanged buffer skip the whole-buffer rescan. */
export function requestBufferVisuals(
  bufferId: number,
  refreshGitGutter = true,
  epoch: number | null = null
) {
  const prev = visualsQueue.get(bufferId);
  visualsQueue.set(bufferId, {
    gutter: refreshGitGutter || (prev ? prev.gutter : false),
    epoch: epoch !== null ? epoch : prev ? prev.epoch : null,
  });
  if (visualsTimer !== null) editor.clearInterval(visualsTimer);
  visualsTimer = editor.setTimeout(VISUALS_DEBOUNCE_MS, "freshVisualsFlush");
}

function freshVisualsFlush() {
  visualsTimer = null;
  const batch = Array.from(visualsQueue.entries());
  visualsQueue.clear();
  for (const [bufferId, req] of batch) {
    if (visualsInFlight.has(bufferId)) {
      // A pass is already running for this buffer; fold this request into the
      // next one instead of starting a second overlapping scan.
      const cur = visualsQueue.get(bufferId);
      visualsQueue.set(bufferId, {
        gutter: req.gutter || (cur ? cur.gutter : false),
        epoch: req.epoch !== null ? req.epoch : cur ? cur.epoch : null,
      });
      visualsPendingAgain.add(bufferId);
      continue;
    }
    void runBufferVisuals(bufferId, req);
  }
}
registerHandler("freshVisualsFlush", freshVisualsFlush);

async function runBufferVisuals(bufferId: number, req: VisualRequest) {
  visualsInFlight.add(bufferId);
  try {
    if (req.gutter) {
      await updateCustomGitGutter(bufferId);
    }
    // The scan is whole-buffer and idempotent per buffer version: if the
    // version is unchanged since the last scan, the result is identical.
    if (req.epoch === null) {
      // A file event (open/save/revert/activate) is authoritative: forget the
      // cached version so the next batch cannot skip the rescan.
      lastScannedEpoch.delete(bufferId);
    } else if (lastScannedEpoch.get(bufferId) === req.epoch) {
      return;
    } else {
      lastScannedEpoch.set(bufferId, req.epoch);
    }
    await refreshBufferSyntax(bufferId);
  } finally {
    visualsInFlight.delete(bufferId);
    if (visualsPendingAgain.delete(bufferId)) {
      if (visualsTimer !== null) editor.clearInterval(visualsTimer);
      visualsTimer = editor.setTimeout(0, "freshVisualsFlush");
    }
  }
}

async function refreshBufferSyntax(bufferId: number) {
  try {
    const info = editor.getBufferInfo(bufferId);
    if (!info || !info.path) return;
    const p = info.path.toLowerCase();

    // Syntax Enhancers
    if (p.endsWith(".java")) {
      await refreshJavaBuffer(bufferId);
    } else if (p.endsWith(".xml") || p.endsWith(".xsd") || p.endsWith(".pom") || p.endsWith(".svg")) {
      await refreshXmlBuffer(bufferId);
    } else if (p.endsWith(".yml") || p.endsWith(".yaml")) {
      await refreshYamlBuffer(bufferId);
    } else if (p.endsWith(".properties") || p.endsWith(".env") || p.endsWith(".ini") || p.endsWith(".conf")) {
      await refreshPropertiesBuffer(bufferId);
    }
  } catch (_e) {
    // Ignore error
  }
}

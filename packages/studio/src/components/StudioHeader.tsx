import { useRef, type MouseEvent } from "react";
import { RotateCcw, RotateCw, Camera } from "../icons/SystemIcons";
import {
  STUDIO_INSPECTOR_PANELS_ENABLED,
  STUDIO_MANUAL_EDITING_DISABLED_TITLE,
} from "./editor/manualEditingAvailability";
import { getHistoryShortcutLabel } from "../utils/studioHelpers";
import { useStudioShellContext } from "../contexts/StudioContext";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import { useViewMode, type StudioViewMode } from "../contexts/ViewModeContext";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { Tooltip } from "./ui";

export interface StudioHeaderProps {
  captureFrameHref: string;
  captureFrameFilename: string;
  handleCaptureFrameClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  refreshCaptureFrameTime: () => void;
  capturing?: boolean;
  inspectorButtonActive: boolean;
  inspectorPanelActive: boolean;
  onExport?: () => void;
}

function HyperframesLogo() {
  // KENECT AI lockup for the dark header: K-mark in a rounded square with
  // the brand accent, wordmark set in the UI font.
  const height = 28;
  return (
    <svg
      width={Math.round(height * (300 / 60))}
      height={height}
      viewBox="0 0 300 60"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="KENECT AI"
    >
      <rect x="2" y="10" width="40" height="40" rx="9" fill="#F6F5F1" />
      <path
        d="M13 19v22M13 30l11-11M14.5 28.5L25 41"
        stroke="#3CE6AC"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="33" cy="20" r="3.2" fill="#3CE6AC" />
      <text
        x="52"
        y="41"
        fontFamily="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontSize="27"
        fontWeight="800"
        letterSpacing="1.5"
        fill="#F6F5F1"
      >
        KENECT
      </text>
      <text
        x="182"
        y="41"
        fontFamily="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontSize="27"
        fontWeight="300"
        letterSpacing="1.5"
        fill="#F6F5F1"
      >
        AI
      </text>
    </svg>
  );
}

const VIEW_MODE_OPTIONS: Array<{ mode: StudioViewMode; label: string }> = [
  { mode: "storyboard", label: "Storyboard" },
  { mode: "timeline", label: "Preview" },
];

/** Segmented control switching the main stage between storyboard and preview. */
function ViewModeToggle() {
  const { viewMode, setViewMode } = useViewMode();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectMode = (mode: StudioViewMode) => {
    if (mode === viewMode) return;
    trackStudioEvent("view_mode_toggle", { mode });
    setViewMode(mode);
  };

  // Complete APG tabs pattern: roving tabIndex + arrow-key navigation.
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    const next = (index + dir + VIEW_MODE_OPTIONS.length) % VIEW_MODE_OPTIONS.length;
    tabRefs.current[next]?.focus();
    selectMode(VIEW_MODE_OPTIONS[next].mode);
  };

  return (
    <div
      className="flex items-center gap-0.5 rounded-md bg-neutral-800 p-0.5"
      role="tablist"
      aria-label="Studio view"
    >
      {VIEW_MODE_OPTIONS.map(({ mode, label }, index) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => selectMode(mode)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`rounded px-3 py-1 text-[11px] font-medium transition-colors active:scale-[0.98] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent ${
              active ? "bg-neutral-200 text-neutral-900" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// fallow-ignore-next-line complexity
export function StudioHeader({
  captureFrameHref,
  captureFrameFilename,
  handleCaptureFrameClick,
  refreshCaptureFrameTime,
  capturing,
  inspectorButtonActive,
  inspectorPanelActive,
  onExport,
}: StudioHeaderProps) {
  const { projectId, editHistory, handleUndo, handleRedo, renderQueue } = useStudioShellContext();
  const { rightCollapsed, setRightCollapsed, setRightPanelTab } = usePanelLayoutContext();
  const isRendering = renderQueue.isRendering;

  return (
    <div className="flex items-center justify-between h-10 px-3 bg-neutral-900 border-b border-neutral-800 flex-shrink-0">
      {/* Left: logo + project name */}
      <div className="flex items-center gap-3">
        <HyperframesLogo />
        <span className="text-neutral-700 select-none" aria-hidden="true">
          |
        </span>
        <span className="text-[11px] font-medium text-neutral-300">{projectId}</span>
      </div>
      {/* Center: storyboard / preview toggle */}
      <ViewModeToggle />
      {/* Right: toolbar buttons */}
      <div className="flex items-center gap-1.5">
        <Tooltip
          label={
            editHistory.undoLabel
              ? `Undo ${editHistory.undoLabel} (${getHistoryShortcutLabel("undo")})`
              : `Undo (${getHistoryShortcutLabel("undo")})`
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={() => {
              trackStudioEvent("toolbar_action", { action: "undo" });
              void handleUndo();
            }}
            disabled={!editHistory.canUndo}
            className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors active:scale-[0.98] ${
              editHistory.canUndo
                ? "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                : "text-neutral-700 cursor-default"
            }`}
            aria-label="Undo"
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
        <Tooltip
          label={
            editHistory.redoLabel
              ? `Redo ${editHistory.redoLabel} (${getHistoryShortcutLabel("redo")})`
              : `Redo (${getHistoryShortcutLabel("redo")})`
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={() => {
              trackStudioEvent("toolbar_action", { action: "redo" });
              void handleRedo();
            }}
            disabled={!editHistory.canRedo}
            className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors active:scale-[0.98] ${
              editHistory.canRedo
                ? "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                : "text-neutral-700 cursor-default"
            }`}
            aria-label="Redo"
          >
            <RotateCw size={14} />
          </button>
        </Tooltip>
        <Tooltip label={capturing ? "Capturing frame…" : "Capture current frame"} side="bottom">
          <a
            href={captureFrameHref}
            download={captureFrameFilename}
            onClick={(e) => {
              if (capturing) {
                e.preventDefault();
                return;
              }
              trackStudioEvent("toolbar_action", { action: "capture_frame" });
              handleCaptureFrameClick(e);
            }}
            onFocus={refreshCaptureFrameTime}
            onPointerDown={refreshCaptureFrameTime}
            aria-disabled={capturing || undefined}
            className={`h-7 flex items-center gap-1.5 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
              capturing
                ? "text-neutral-600 cursor-default"
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 active:scale-[0.98]"
            }`}
            aria-label={capturing ? "Capturing frame" : "Capture current frame"}
          >
            {capturing ? (
              <svg
                className="animate-spin motion-reduce:animate-none h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
              <Camera size={14} />
            )}
            <span>{capturing ? "Capturing…" : "Capture"}</span>
          </a>
        </Tooltip>
        <Tooltip
          label={
            STUDIO_INSPECTOR_PANELS_ENABLED ? "Inspector" : STUDIO_MANUAL_EDITING_DISABLED_TITLE
          }
          side="bottom"
        >
          <button
            type="button"
            onClick={() => {
              if (!STUDIO_INSPECTOR_PANELS_ENABLED) return;
              if (rightCollapsed || !inspectorPanelActive) {
                trackStudioEvent("panel_toggle", { panel: "inspector", collapsed: false });
                setRightPanelTab("design");
                setRightCollapsed(false);
                return;
              }
              trackStudioEvent("panel_toggle", { panel: "inspector", collapsed: true });
              // Keep the current selection when collapsing the Inspector — closing
              // the panel shouldn't deselect the element.
              setRightCollapsed(true);
            }}
            disabled={!STUDIO_INSPECTOR_PANELS_ENABLED}
            aria-pressed={inspectorButtonActive}
            className={`h-7 flex items-center gap-1.5 px-2.5 rounded-md text-[11px] font-medium border transition-colors active:scale-[0.98] ${
              inspectorButtonActive
                ? "text-studio-accent bg-studio-accent/10 border-studio-accent/30"
                : STUDIO_INSPECTOR_PANELS_ENABLED
                  ? "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 border-transparent"
                  : "cursor-not-allowed border-transparent text-neutral-700"
            }`}
            aria-label={
              STUDIO_INSPECTOR_PANELS_ENABLED ? "Inspector" : STUDIO_MANUAL_EDITING_DISABLED_TITLE
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="10 8 16 12 10 16" fill="currentColor" stroke="none" />
            </svg>
            Inspector
          </button>
        </Tooltip>
        <Tooltip
          label={
            isRendering ? "A render is already in progress" : "Render and export this composition"
          }
          side="bottom"
        >
          <button
            type="button"
            disabled={isRendering}
            onClick={() => {
              if (isRendering) return;
              setRightPanelTab("renders");
              setRightCollapsed(false);
              onExport?.();
            }}
            className="h-7 flex items-center gap-1.5 px-3 rounded-md text-[11px] font-semibold bg-studio-accent text-[#09090B] enabled:hover:brightness-110 transition-[filter,transform] enabled:active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRendering ? "Rendering…" : "Export"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

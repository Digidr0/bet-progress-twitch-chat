import {
  Index,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import "./ProgressBar.css";

type ProgressOption = {
  label: string;
  percent: number;
};

type ProgressBarProps = {
  title: string;
  time: string;
  options: ProgressOption[];
  hasData: boolean;
  isExpired: boolean;
};

const segmentIcons = [
  "/svg/Ball-predict-1.svg",
  "/svg/Ball-predict-2.svg",
  "/svg/Ball-predict-3.svg",
  "/svg/Ball-predict-4.svg",
  "/svg/Ball-predict-5.svg",
  "/svg/Ball-predict-6.svg",
];

const ICON_THRESHOLD = 20;

const segmentType = (index: number, total: number) => {
  if (total === 2) {
    return index === 0 ? "type-1" : "type-2";
  }
  return "type-1";
};

const segmentIcon = (index: number, total: number) => {
  if (total === 2 && index === 1) {
    return "/svg/Ball-predict-2-red.svg";
  }
  return segmentIcons[index] ?? segmentIcons[segmentIcons.length - 1];
};

type SegmentProps = {
  option: () => ProgressOption;
  index: number;
  total: () => number;
};

function Segment(props: SegmentProps) {
  const [compact, setCompact] = createSignal(false);
  let segmentRef: HTMLDivElement | undefined;
  let textRef: HTMLSpanElement | undefined;
  let measureRef: HTMLSpanElement | undefined;
  let valueGroupRef: HTMLSpanElement | undefined;
  let frame = 0;
  let resizeObserver: ResizeObserver | undefined;

  const applyCompact = (nextCompact: boolean) => {
    if (nextCompact === compact()) return;
    if (!valueGroupRef) {
      setCompact(nextCompact);
      return;
    }
    const first = valueGroupRef.getBoundingClientRect();
    setCompact(nextCompact);
    requestAnimationFrame(() => {
      if (!valueGroupRef) return;
      const last = valueGroupRef.getBoundingClientRect();
      const dx = first.left - last.left;
      if (Math.abs(dx) > 0.5) {
        valueGroupRef.animate(
          [
            { transform: `translateX(${dx}px)` },
            { transform: "translateX(0)" },
          ],
          { duration: 200, easing: "ease-out" },
        );
      }
    });
  };

  const measure = () => {
    if (!segmentRef || !textRef || !measureRef) return;
    const availableWidth = textRef.clientWidth;
    const neededWidth = measureRef.scrollWidth;
    applyCompact(neededWidth > availableWidth);
  };

  const scheduleMeasure = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };

  onMount(() => {
    scheduleMeasure();
    if (typeof ResizeObserver !== "undefined" && segmentRef) {
      resizeObserver = new ResizeObserver(() => scheduleMeasure());
      resizeObserver.observe(segmentRef);
    }
  });

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
  });

  createEffect(() => {
    props.option().label;
    props.option().percent;
    props.total();
    scheduleMeasure();
  });

  return (
    <div
      ref={(el) => (segmentRef = el)}
      class={`segment ${segmentType(props.index, props.total())}`}
      style={{
        width: `${props.option().percent}%`,
      }}
    >
      {props.option().percent >= ICON_THRESHOLD && (
        <img
          class="segment-icon"
          src={segmentIcon(props.index, props.total())}
          alt=""
          aria-hidden="true"
        />
      )}
      <span ref={(el) => (textRef = el)} class="segment-text">
        <span class="segment-label">
          {(compact() ? props.index + 1 : props.option().label) + ":"}
        </span>
        <span ref={(el) => (valueGroupRef = el)} class="segment-value-group">
          <span class="segment-value">{props.option().percent}%</span>
        </span>
        <span ref={(el) => (measureRef = el)} class="segment-measure">
          <span class="segment-label">{props.option().label}:</span>
          <span class="segment-value">{props.option().percent}%</span>
        </span>
      </span>
    </div>
  );
}

function ProgressBar(props: ProgressBarProps) {
  const total = () => props.options.length;

  return (
    <section class="panel preview">
      <div class="preview-header">
        <span class="preview-left">
          <img
            class="preview-icon"
            src="/svg/Magic-ball-white.svg"
            alt=""
            aria-hidden="true"
          />
          <span class="preview-label">
            {props.isExpired ? "Прогноз завершён" : "Прогноз"}
          </span>
        </span>
        <span class="preview-title">{props.title}</span>
        <span class={`preview-time ${props.isExpired ? "is-muted" : ""}`}>
          {props.time}
        </span>
      </div>
      <div class="progress-bar">
        {props.hasData ? (
          <Index each={props.options}>
            {(option, index) => (
              <Segment option={option} index={index} total={total} />
            )}
          </Index>
        ) : (
          <div class="progress-empty">
            Нажмите «Отправить», чтобы показать прогноз.
          </div>
        )}
      </div>
    </section>
  );
}

export default ProgressBar;

import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import "./App.css";
import ProgressBar from "./ProgressBar";
import TwitchSocketPanel from "./TwitchSocketPanel";

type Option = {
  id: number;
  label: string;
  percent: number;
};

const MAX_OPTIONS = 6;
const DEFAULT_PRESET_SECONDS = 60;
const STORAGE_KEY = "bet-progress:builder";

const createDefaultOptions = (): Option[] => [
  { id: 1, label: "Вариант 1", percent: 50 },
  { id: 2, label: "Вариант 2", percent: 50 },
];

const buildPercents = (count: number) => {
  const base = Math.floor(100 / count);
  let remainder = 100 - base * count;
  return Array.from({ length: count }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return base + extra;
  });
};

const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Math.round(value)));

const normalizeOptions = (raw: unknown): Option[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return createDefaultOptions();
  }

  const slice = raw.slice(0, MAX_OPTIONS);
  const cleaned = slice.map((item, index) => {
    const record =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const labelValue =
      typeof record.label === "string" ? record.label.trim() : "";
    const label = labelValue.length > 0 ? labelValue : `Вариант ${index + 1}`;
    const percentValue =
      typeof record.percent === "number" ? record.percent : NaN;
    const percent = Number.isFinite(percentValue)
      ? Math.round(percentValue)
      : NaN;
    return {
      id: index + 1,
      label,
      percent,
    };
  });

  if (cleaned.length < 2) {
    return createDefaultOptions();
  }

  const allFinite = cleaned.every((option) => Number.isFinite(option.percent));
  const sum = cleaned.reduce(
    (total, option) =>
      total + (Number.isFinite(option.percent) ? option.percent : 0),
    0,
  );

  if (!allFinite || sum !== 100) {
    const percents = buildPercents(cleaned.length);
    return cleaned.map((option, index) => ({
      ...option,
      percent: percents[index],
    }));
  }

  return cleaned;
};

function App() {
  const [title, setTitle] = createSignal("");
  const [active, setActive] = createSignal(true);
  const [options, setOptions] = createStore<Option[]>(createDefaultOptions());
  const [jsonOutput, setJsonOutput] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const initialEndTime = Math.floor(Date.now() / 1000) + DEFAULT_PRESET_SECONDS;
  const [presetSeconds, setPresetSeconds] = createSignal(
    DEFAULT_PRESET_SECONDS,
  );
  const [endTimeUnix, setEndTimeUnix] = createSignal(String(initialEndTime));

  let nextId = options.length + 1;

  onMount(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    onCleanup(() => {
      window.clearInterval(intervalId);
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object") return;

        if (typeof data.title === "string") {
          setTitle(data.title);
        }
        if (typeof data.active === "boolean") {
          setActive(data.active);
        }

        if (
          typeof data.endTimeUnix === "number" &&
          Number.isFinite(data.endTimeUnix)
        ) {
          setPresetSeconds(0);
          setEndTimeUnix(String(Math.floor(data.endTimeUnix)));
        }

        const normalized = normalizeOptions(
          Array.isArray(data.options) ? data.options : [],
        );
        setOptions(reconcile(normalized));
        nextId = normalized.length + 1;

        const payload = {
          title: typeof data.title === "string" ? data.title : "",
          active: typeof data.active === "boolean" ? data.active : true,
          endTimeUnix:
            typeof data.endTimeUnix === "number" &&
            Number.isFinite(data.endTimeUnix)
              ? Math.floor(data.endTimeUnix)
              : null,
          options: normalized.map((option) => ({
            label: option.label.trim(),
            percent: option.percent,
          })),
        };
        setJsonOutput(JSON.stringify(payload, null, 2));
      } catch {
        // ignore invalid storage
      }
    }
  });

  const previewData = createMemo(() => {
    const raw = jsonOutput().trim();
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      const normalized = normalizeOptions(
        Array.isArray(data.options) ? data.options : [],
      );
      return {
        title: typeof data.title === "string" ? data.title : "",
        endTimeUnix:
          typeof data.endTimeUnix === "number" &&
          Number.isFinite(data.endTimeUnix)
            ? Math.floor(data.endTimeUnix)
            : null,
        options: normalized,
      };
    } catch {
      return null;
    }
  });

  const previewTitle = createMemo(() => {
    const data = previewData();
    if (!data) return "Нет данных";
    const title = data.title.trim();
    return title.length > 0 ? title : "Без названия";
  });

  const formattedRemainingTime = createMemo(() => {
    const data = previewData();
    if (!data || data.endTimeUnix === null) return "--:--";
    const remaining = Math.max(0, data.endTimeUnix - Math.floor(now() / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
      2,
      "0",
    )}`;
  });

  const isExpired = createMemo(() => {
    const data = previewData();
    if (!data || data.endTimeUnix === null) return false;
    return Math.floor(now() / 1000) >= data.endTimeUnix;
  });

  const totalPercent = () =>
    options.reduce((sum, option) => sum + option.percent, 0);

  const addOption = () => {
    setOptions(
      produce((draft) => {
        if (draft.length >= MAX_OPTIONS) return;
        const nextCount = draft.length + 1;
        const percents = buildPercents(nextCount);
        draft.forEach((option, index) => {
          option.percent = percents[index];
        });
        draft.push({
          id: nextId++,
          label: `Вариант ${nextCount}`,
          percent: percents[nextCount - 1],
        });
      }),
    );
  };

  const removeOption = (id: number) => {
    setOptions(
      produce((draft) => {
        if (draft.length <= 2) return;
        const index = draft.findIndex((option) => option.id === id);
        if (index === -1) return;
        draft.splice(index, 1);
        const percents = buildPercents(draft.length);
        draft.forEach((option, idx) => {
          option.percent = percents[idx];
        });
      }),
    );
  };

  const updateLabel = (id: number, value: string) => {
    setOptions((option) => option.id === id, "label", value);
  };

  const updatePercent = (id: number, value: number) => {
    setOptions(
      produce((draft) => {
        if (draft.length === 0) return;
        const targetIndex = draft.findIndex((option) => option.id === id);
        if (targetIndex === -1) return;

        const target = clampPercent(value);
        if (draft[targetIndex].percent === target) return;

        const remaining = 100 - target;
        const otherIndices = draft
          .map((option, index) => (option.id === id ? -1 : index))
          .filter((index) => index !== -1);

        if (otherIndices.length === 0) {
          draft[targetIndex].percent = 100;
          return;
        }

        const othersTotal = otherIndices.reduce(
          (sum, index) => sum + draft[index].percent,
          0,
        );

        const allocations = new Map<number, number>();

        if (othersTotal === 0) {
          const base = Math.floor(remaining / otherIndices.length);
          let remainder = remaining - base * otherIndices.length;
          otherIndices.forEach((index) => {
            const extra = remainder > 0 ? 1 : 0;
            remainder -= extra;
            allocations.set(index, base + extra);
          });
        } else {
          const scaled = otherIndices.map((index) => {
            const raw = (draft[index].percent * remaining) / othersTotal;
            const base = Math.floor(raw);
            return {
              index,
              base,
              frac: raw - base,
            };
          });

          let used = scaled.reduce((sum, item) => sum + item.base, 0);
          let remainder = remaining - used;
          scaled.sort((a, b) => b.frac - a.frac);
          for (let i = 0; i < remainder; i += 1) {
            scaled[i % scaled.length].base += 1;
          }
          scaled.forEach((item) => allocations.set(item.index, item.base));
        }

        draft[targetIndex].percent = target;
        otherIndices.forEach((index) => {
          draft[index].percent = allocations.get(index) ?? 0;
        });
      }),
    );
  };

  const applyPreset = (seconds: number) => {
    setPresetSeconds(seconds);
    const nextTime = Math.floor(Date.now() / 1000) + seconds;
    setEndTimeUnix(String(nextTime));
  };

  const updateManualEndTime = (value: string) => {
    setPresetSeconds(0);
    setEndTimeUnix(value);
  };

  const handleSubmit = () => {
    let endTimeUnixValue: number | null = null;
    if (presetSeconds() > 0) {
      endTimeUnixValue = Math.floor(Date.now() / 1000) + presetSeconds();
      setEndTimeUnix(String(endTimeUnixValue));
    } else {
      const manualValue = Number(endTimeUnix());
      endTimeUnixValue = Number.isFinite(manualValue)
        ? Math.floor(manualValue)
        : null;
    }

    const payload = {
      title: title().trim(),
      active: active(),
      endTimeUnix: endTimeUnixValue,
      options: options.map((option) => ({
        label: option.label.trim(),
        percent: option.percent,
      })),
    };
    const json = JSON.stringify(payload, null, 2);
    setJsonOutput(json);
    localStorage.setItem(STORAGE_KEY, json);
  };

  const previewOptions = () => previewData()?.options ?? [];
  const hasPreview = () => previewData() !== null;

  return (
    <div class="page">
      <div class="column">
        <ProgressBar
          title={previewTitle()}
          time={formattedRemainingTime()}
          options={previewOptions()}
          hasData={hasPreview()}
          isExpired={isExpired()}
        />

        <section class="panel">
          <h1>Конструктор</h1>

          <label class="field">
            <span>Название</span>
            <input
              type="text"
              value={title()}
              placeholder="Название ставки"
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>

          <div class="field">
            <span>Статус</span>
            <div class="switch" data-active={active() ? "true" : "false"}>
              <span class="switch-label">Неактивен</span>
              <label class="switch-control">
                <input
                  type="checkbox"
                  checked={active()}
                  onInput={(event) => setActive(event.currentTarget.checked)}
                />
                <span class="switch-track" />
              </label>
              <span class="switch-label">Активен</span>
            </div>
          </div>

          <div class="field">
            <span>Окончание (Unix)</span>
            <div class="time-row">
              <div class="preset-group">
                <button
                  type="button"
                  class="preset"
                  data-active={presetSeconds() === 5 ? "true" : "false"}
                  onClick={() => applyPreset(5)}
                >
                  5 сек
                </button>
                <button
                  type="button"
                  class="preset"
                  data-active={presetSeconds() === 30 ? "true" : "false"}
                  onClick={() => applyPreset(30)}
                >
                  30 сек
                </button>
                <button
                  type="button"
                  class="preset"
                  data-active={presetSeconds() === 60 ? "true" : "false"}
                  onClick={() => applyPreset(60)}
                >
                  1 мин
                </button>
                <button
                  type="button"
                  class="preset"
                  data-active={presetSeconds() === 120 ? "true" : "false"}
                  onClick={() => applyPreset(120)}
                >
                  2 мин
                </button>
              </div>
              <input
                class="time-input"
                type="number"
                min="0"
                value={endTimeUnix()}
                onInput={(event) =>
                  updateManualEndTime(event.currentTarget.value)
                }
              />
            </div>
          </div>

          <div class="options">
            <div class="options-header">
              <span>Варианты</span>
            </div>

            <For each={options}>
              {(option) => (
                <div class="option-row">
                  <input
                    class="option-name"
                    type="text"
                    value={option.label}
                    onInput={(event) =>
                      updateLabel(option.id, event.currentTarget.value)
                    }
                  />
                  <input
                    class="option-slider"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={option.percent}
                    onInput={(event) =>
                      updatePercent(
                        option.id,
                        event.currentTarget.valueAsNumber,
                      )
                    }
                  />
                  <span class="option-percent">{option.percent}%</span>
                  <button
                    type="button"
                    class="remove"
                    onClick={() => removeOption(option.id)}
                    disabled={options.length <= 2}
                    title={
                      options.length <= 2
                        ? "Нужно минимум 2 варианта"
                        : "Удалить вариант"
                    }
                  >
                    ×
                  </button>
                </div>
              )}
            </For>

            <div class="total">Итого: {totalPercent()}%</div>

            <button
              type="button"
              class="add add-bottom"
              onClick={addOption}
              disabled={options.length >= MAX_OPTIONS}
              title={
                options.length >= MAX_OPTIONS
                  ? "Максимум 6 вариантов"
                  : "Добавить вариант"
              }
            >
              +
            </button>
          </div>

          <button type="button" class="submit" onClick={handleSubmit}>
            Отправить
          </button>
        </section>
      </div>

      <section class="panel output">
        <h2>JSON</h2>
        <pre>
          {jsonOutput() || "Нажмите «Отправить», чтобы сгенерировать JSON."}
        </pre>
      </section>

      <TwitchSocketPanel />
    </div>
  );
}

export default App;

"use client";

export type RecurrenceFrequencyMode = "weekly" | "biweekly" | "custom";

export type SeriesVigenciaMode = "never" | "date";

export function intervalWeeksFromMode(mode: RecurrenceFrequencyMode, customInterval: string): number {
  if (mode === "weekly") return 1;
  if (mode === "biweekly") return 2;
  return parseInt(customInterval, 10) || 1;
}

export function frequencyModeFromInterval(intervalWeeks: number): RecurrenceFrequencyMode {
  if (intervalWeeks === 1) return "weekly";
  if (intervalWeeks === 2) return "biweekly";
  return "custom";
}

export function frequencyLabelFromInterval(intervalWeeks: number): string {
  if (intervalWeeks === 1) return "Cada semana";
  if (intervalWeeks === 2) return "Cada 2 semanas";
  return `Cada ${intervalWeeks} semanas`;
}

export function SeriesRecurrenceFields({
  frequencyMode,
  customInterval,
  onFrequencyModeChange,
  onCustomIntervalChange,
  vigenciaMode,
  endsOn,
  onVigenciaModeChange,
  onEndsOnChange,
}: {
  frequencyMode: RecurrenceFrequencyMode;
  customInterval: string;
  onFrequencyModeChange: (mode: RecurrenceFrequencyMode) => void;
  onCustomIntervalChange: (value: string) => void;
  vigenciaMode: SeriesVigenciaMode;
  endsOn: string;
  onVigenciaModeChange: (mode: SeriesVigenciaMode) => void;
  onEndsOnChange: (value: string) => void;
}) {
  return (
    <>
      <label className="block text-sm">
        <span className="text-zinc-600">Repetición</span>
        <select
          className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
          value={frequencyMode}
          onChange={(e) => onFrequencyModeChange(e.target.value as RecurrenceFrequencyMode)}
        >
          <option value="weekly">Cada semana</option>
          <option value="biweekly">Cada 2 semanas</option>
          <option value="custom">Personalizada</option>
        </select>
      </label>
      {frequencyMode === "custom" ? (
        <label className="block text-sm">
          <span className="text-zinc-600">Cada cuántas semanas</span>
          <input
            type="number"
            min={1}
            max={52}
            className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2"
            value={customInterval}
            onChange={(e) => onCustomIntervalChange(e.target.value)}
          />
        </label>
      ) : null}

      <fieldset className="space-y-2 text-sm">
        <legend className="text-zinc-600">Vigencia</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={vigenciaMode === "never"}
            onChange={() => onVigenciaModeChange("never")}
          />
          Sin fecha de fin
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={vigenciaMode === "date"}
            onChange={() => onVigenciaModeChange("date")}
          />
          Hasta una fecha
        </label>
        {vigenciaMode === "date" ? (
          <input
            type="date"
            className="w-full rounded-xl border border-zinc-200 px-3 py-2"
            value={endsOn}
            onChange={(e) => onEndsOnChange(e.target.value)}
          />
        ) : null}
      </fieldset>
    </>
  );
}

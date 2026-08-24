/**
 * Default sub-objects Super Productivity attaches to every project and tag.
 *
 * These are transcribed from operations in a real sync file rather than
 * invented. They matter because the desktop app reads them without guarding:
 * a project created without `advancedCfg.worklogExportSettings` throws when the
 * user opens the worklog export dialog, and one without a `theme` renders with
 * an undefined primary colour.
 *
 * Emitting a *complete* entity is the difference between a project this server
 * created and a project Super Productivity created.
 */

export interface WorklogExportSettings {
  cols: string[];
  roundWorkTimeTo: string | null;
  roundStartTimeTo: string | null;
  roundEndTimeTo: string | null;
  separateTasksBy: string;
  groupBy: string;
}

export interface AdvancedConfig {
  worklogExportSettings: WorklogExportSettings;
}

export interface EntityTheme {
  isAutoContrast: boolean;
  isDisableBackgroundTint: boolean;
  primary: string;
  huePrimary: string;
  accent: string;
  hueAccent: string;
  warn: string;
  hueWarn: string;
  backgroundImageDark: string | null;
  backgroundImageLight: string | null;
  backgroundOverlayOpacity: number;
  backgroundImageBlur: number;
}

export const defaultAdvancedConfig = (): AdvancedConfig => ({
  worklogExportSettings: {
    cols: ['DATE', 'START', 'END', 'TIME_CLOCK', 'TITLES_INCLUDING_SUB'],
    roundWorkTimeTo: null,
    roundStartTimeTo: null,
    roundEndTimeTo: null,
    separateTasksBy: ' | ',
    groupBy: 'DATE',
  },
});

/** Super Productivity's default accent palette, used when no colour is given. */
export const DEFAULT_PRIMARY_COLOR = '#26c6da';

export const defaultTheme = (primary: string = DEFAULT_PRIMARY_COLOR): EntityTheme => ({
  isAutoContrast: true,
  isDisableBackgroundTint: false,
  primary,
  huePrimary: '500',
  accent: '#ff4081',
  hueAccent: '500',
  warn: '#e11826',
  hueWarn: '500',
  backgroundImageDark: null,
  backgroundImageLight: null,
  backgroundOverlayOpacity: 20,
  backgroundImageBlur: 0,
});

import { Menu, MenuItem, MenuLabel } from '@plastago/ui';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { THEME_MODES, type ThemeMode } from '@/lib/theme';
import { useTheme } from './theme-context';

const MODE_ICON = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
} as const;

const MODE_LABEL: Record<ThemeMode, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

export interface ThemeToggleProps {
  /** `sidebar` inverts the colours for use on the dark navigation rail. */
  tone?: 'default' | 'sidebar';
}

export function ThemeToggle({ tone = 'default' }: ThemeToggleProps) {
  const { mode, setMode } = useTheme();
  const Icon = MODE_ICON[mode];

  return (
    <Menu
      align="end"
      triggerLabel={`Theme: ${MODE_LABEL[mode]}`}
      triggerClassName={
        tone === 'sidebar'
          ? 'grid size-9 place-items-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent'
          : 'grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
      }
      trigger={<Icon aria-hidden className="size-4" />}
    >
      <MenuLabel>Appearance</MenuLabel>
      {THEME_MODES.map((option) => {
        const OptionIcon = MODE_ICON[option];
        return (
          <MenuItem
            key={option}
            icon={OptionIcon}
            onSelect={() => {
              setMode(option);
            }}
          >
            {MODE_LABEL[option]}
            {option === mode && <span className="sr-only"> (selected)</span>}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

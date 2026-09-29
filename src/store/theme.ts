import { create } from 'zustand';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'mapgen.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

const resolve = (pref: ThemePref): 'light' | 'dark' => (pref === 'system' ? (media.matches ? 'dark' : 'light') : pref);

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

interface ThemeStore {
  pref: ThemePref;
  resolved: 'light' | 'dark';
  setPref: (p: ThemePref) => void;
}

export const useTheme = create<ThemeStore>((set) => ({
  pref: readPref(),
  resolved: resolve(readPref()),
  setPref: (pref) => {
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* storage unavailable */
    }
    apply(pref);
    set({ pref, resolved: resolve(pref) });
  },
}));

media.addEventListener('change', () => {
  const { pref } = useTheme.getState();
  useTheme.setState({ resolved: resolve(pref) });
});

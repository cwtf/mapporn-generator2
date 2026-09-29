import { create } from 'zustand';
import { emptyMapState, type MapState, type MapView } from '../map/types';

interface MapStore {
  map: MapState;
  /** Replace the whole map (e.g. when loading a chat) */
  setMap: (map: MapState) => void;
  /** Mutate a copy of the map and publish it */
  update: (fn: (draft: MapState) => void) => MapState;
  setView: (view: MapView) => void;
  reset: () => void;
}

export const useMapStore = create<MapStore>((set, get) => ({
  map: emptyMapState(),
  setMap: (map) => set({ map: { ...emptyMapState(), ...structuredClone(map) } }),
  update: (fn) => {
    const draft = structuredClone(get().map);
    fn(draft);
    set({ map: draft });
    return draft;
  },
  setView: (view) => set((s) => ({ map: { ...s.map, view } })),
  reset: () => set({ map: emptyMapState() }),
}));


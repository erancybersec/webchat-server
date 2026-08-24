const DENSITY_KEY = 'wa_job_density';

export type Density = 'comfortable' | 'compact';

export function initialDensity(): Density {
  try {
    const saved = localStorage.getItem(DENSITY_KEY);
    if (saved === 'comfortable' || saved === 'compact') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'comfortable';
}

export function saveDensity(density: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* storage unavailable */
  }
}

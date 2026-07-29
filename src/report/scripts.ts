// Embedded JS. Phase 0 needs almost nothing — <details> handles expand
// natively, no charts yet. This lives as a hook so phase 1 can drop
// Chart.js UMD + sort/filter handlers in without changing the shell.

export const SCRIPTS = `
// no-op for phase 0. Placeholder to keep the shell stable.
`;

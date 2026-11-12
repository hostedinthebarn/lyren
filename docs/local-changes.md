# Local changes in hostedinthebarn/lyren

Where this repository differs from upstream (`Cleptomania/lyren-plan`). Check this list when merging upstream.

- **Sidebar Projects sort (LYR-16, not sent upstream).** `web/src/components/layout/Sidebar.tsx` gains a sort menu in the Projects section header (`ProjectSortMenu`, and an `actions` slot on `NavSection`); the sort logic is in the new `web/src/components/layout/projectSort.ts` with its test. Client-only: `position` and the server are untouched. Choice kept in localStorage `lyren.sidebar.projectsSort`.

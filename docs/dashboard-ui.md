# Dashboard UI baseline

Board and List are the visual baseline for dashboard pages. New pages should
inherit the Mantine theme in `src/dashboard/react/App.tsx` and the shared CSS
properties in `src/dashboard/react/styles.css` before adding page-specific
rules.

- Use `--taskchef-page-max-width`, `--taskchef-page-gutter`, and the
  `.taskchef-main` shell for the outer page. Use `.taskchef-content` for
  readable single-column content; Board may use the full shell width for its
  horizontal lanes.
- Use Mantine `h5`, `sm`, and `xs` sizes for section headings, body text, and
  supporting text. Reserve larger headings for views that establish a distinct
  document hierarchy.
- Selects inherit the compact `xs` dashboard size from the shared Mantine
  theme. New pages get the same 30 px control height and 12 px control text
  without page-specific selectors. Keep short, related selects in one compact
  row when they remain readable at narrow widths; give the field with longer
  values the larger share of the row.
- Use `.taskchef-section`, `p="sm"`, and `gap="sm"` for bordered page sections.
  Keep intentional Board and List differences, such as lane width and card
  excerpts, in their existing component classes.

Check a dashboard page at desktop and narrow widths. Confirm keyboard focus,
control operation, reachable overflow, and a clean browser console.

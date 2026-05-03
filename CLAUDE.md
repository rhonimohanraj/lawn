# Frame (TEG)

Asset review platform for TEG creative teams. Originally forked from Theo's `lawn`, now TEG-owned and extended to handle every file type — video, image, audio, PDF, generic — with nested folders per project.

**Repo conventions:**
- Convex table is named `assets` (not `videos`); `assetKind` enum gates per-type behavior
- Mux pipeline only runs when `assetKind === "video"`
- Folders are first-class: `assets.folderId` + `folders.parentFolderId` give arbitrary nesting
- We are not tracking upstream `pingdotgg/lawn` anymore — feel free to refactor anything

## Design Language

### Philosophy
Brutalist, typographic, minimal. The design should feel bold and direct—like a poster, not a dashboard. Prioritize clarity over decoration. Let typography and whitespace do the heavy lifting.

### Colors
- **Background**: `#f0f0e8` (warm cream)
- **Text**: `#1a1a1a` (near-black)
- **Muted text**: `#888888`
- **Primary accent**: `#2d5a2d` (deep forest green)
- **Accent hover**: `#3a6a3a`
- **Highlight**: `#7cb87c` (soft green for emphasis)
- **Borders**: `#1a1a1a` (strong) or `#ccc` (subtle)
- **Inverted sections**: `#1a1a1a` background with `#f0f0e8` text

### Typography
- **Headings**: Font-black (900 weight), tight tracking
- **Body**: Regular weight, clean and readable
- **Monospace**: For technical info, timestamps, stats
- Use size contrast dramatically—massive headlines with small supporting text

### Borders & Spacing
- Strong 2px borders in `#1a1a1a` for section dividers and cards
- Generous padding (p-6 to p-8 typical)
- Clear visual hierarchy through spacing

### Interactive Elements
- Buttons: Solid backgrounds with bold text, clear hover states
- Links: Underlines, not color-only differentiation
- Hover states: Background fills or color shifts, no subtle opacity changes

### Component Patterns
- **Cards**: 2px black border, cream background, bold title
- **Sections**: Often alternate between cream and dark backgrounds
- **Forms**: Simple inputs with strong borders, no rounded corners or minimal
- **Navigation**: Minimal, text-based, appears on scroll when needed

### Do's
- Use bold typography to create hierarchy
- Embrace whitespace
- Keep interactions obvious and direct
- Use green sparingly as accent, not primary

### Don'ts
- No gradients or shadows (except subtle where functional)
- No rounded corners on primary UI (square/sharp edges)
- No decorative icons—only functional ones
- Don't hide information behind hover states

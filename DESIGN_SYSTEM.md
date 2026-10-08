# Kanban Agent Board - Minimalist Design System

## Overview

The Kanban Agent Board has been completely redesigned with a **minimalist, developer-centric white theme** inspired by Linear and GitHub Projects. This aesthetic prioritizes high-density information display, speed, and zero cognitive bloat.

## Core Design Principles

### 1. High-Contrast Monochromatic Palette

**Base Surfaces:**
- Primary background: `#FFFFFF` (pure white)
- Secondary surfaces: `#F8FAFC` (off-white slate-50)
- Borders: `#E2E8F0` (slate-200) - ultra-fine 1px lines
- No drop shadows except ultra-subtle elevation on drag

**Typography:**
- Primary text: `#0F172A` (slate-900) - charcoal for maximum readability
- Secondary text: `#334155` (slate-700) - dark slate
- Metadata: `#64748B` (slate-500) - muted slate
- Font stack: Inter (sans-serif) + JetBrains Mono (monospace for IDs)

**Semantic Colors (90% neutral):**
- Low priority: `bg-slate-400`
- Medium priority: `bg-blue-500`
- High priority: `bg-amber-500`
- Critical/Urgent: `bg-red-500`
- Running status: `bg-blue-500`
- Done status: `bg-emerald-500`
- Blocked status: `bg-red-500`

### 2. High Information Density & Compact Sizing

**Structured Metadata:**
- Issue IDs use mono-spaced font: `ENG-104` format
- Font: JetBrains Mono / SF Mono
- Size: 10px for IDs, 11-13px for content

**Micro-Pills & Badges:**
- Priority indicators: Small colored dots (1.5px) + text labels
- Status counts: Mono-spaced badges with tight padding
- Agent avatars: 16px square with 3px radius

**Tight Padding:**
- Cards: `p-2.5` (10px)
- Columns: `p-2` (8px)
- Headers: `px-3 py-2.5` (12px horizontal, 10px vertical)
- Compact spacing enables scanning dozens of tasks simultaneously

### 3. Precision Geometry & Borders

**1px Architectural Grid:**
- All boundaries: `border border-slate-200`
- No heavy shadows or background contrast shifts
- Hover states: `hover:border-slate-300` (subtle keyline shift)

**Subtle Radius:**
- Cards: `rounded-[6px]` (6px corners)
- Tags/badges: `rounded-[3px]` to `rounded-[4px]`
- Buttons: `rounded-[4px]`
- Maintains industrial, technical aesthetic

**Ultra-Subtle Elevation:**
- Default: No shadow
- Hover: `shadow-[0_1px_2px_rgba(0,0,0,0.04)]` (barely visible)
- Drag: `shadow-drag` (0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04))

### 4. Keyboard-First & Speed Indicators

**Command Hints:**
- Keyboard shortcuts embedded in buttons: `<kbd>N</kbd>`, `<kbd>P</kbd>`
- Styled with mono font, 1px borders, 2px bottom border for tactile feel
- Background: white with slate borders

**Tactile Micro-Interactions:**
- Hover: Border color shifts from slate-200 to slate-300
- Active states: Background color changes (slate-50, slate-100)
- Drag: Subtle rotation (1deg) + scale (1.05) + shadow elevation

## Component Specifications

### TaskCard

**Structure:**
```
┌─────────────────────────────────┐
│ ENG-104              ● High     │  ← Issue ID (mono) + priority dot
│                                 │
│ Task title text here            │  ← 13px font-medium
│ Brief description...            │  ← 11px text-slate-500
├─────────────────────────────────┤
│ 👤 AgentName    ▶ 💬 ✏️ 🗑️     │  ← Agent bubble + hover actions
└─────────────────────────────────┘
```

**Styling:**
- Background: `bg-white`
- Border: `border border-slate-200`
- Radius: `rounded-[6px]`
- Padding: `p-2.5` (10px all sides)
- Hover: `hover:border-slate-300 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)]`
- Drag: `shadow-drag opacity-90 z-50`

**Priority Indicator:**
- Dot: `w-1.5 h-1.5 rounded-full` with semantic color
- Label: `text-[10px] font-medium` with matching color
- Position: Top-right corner

**Agent Bubble:**
- Avatar: `w-4 h-4 rounded-[3px]` with agent color
- Name: `text-[11px] text-slate-600 font-medium`
- Fallback: Empty square with circle icon for unassigned

**Action Buttons:**
- Visibility: `opacity-0 group-hover:opacity-100`
- Icons: 3px × 3px with hover states
- Start: `hover:bg-emerald-50 hover:text-emerald-600`
- Chat: `hover:bg-slate-100 hover:text-slate-700`
- Edit: `hover:bg-slate-100 hover:text-slate-700`
- Delete: `hover:bg-red-50 hover:text-red-600`

### KanbanColumn

**Structure:**
```
┌──────────────────────┐
│ ● Running    [ 5 ] + │  ← Status dot + title + count + add button
├──────────────────────┤
│                      │
│   [TaskCard]         │
│   [TaskCard]         │
│   [TaskCard]         │
│                      │
└──────────────────────┘
```

**Styling:**
- Background: `bg-slate-50/50`
- Border: `border border-slate-200`
- Radius: `rounded-[6px]`
- Width: `w-[300px]` (fixed for consistency)
- Max height: `max-h-[calc(100vh-180px)]`
- Hover (drop target): `border-slate-400 bg-slate-100/80`

**Header:**
- Status dot: `w-2 h-2 rounded-full` with semantic color
- Title: `text-[13px] font-semibold text-slate-900`
- Count badge: `text-[11px] font-mono bg-slate-100 px-1.5 py-0.5 rounded-[3px]`
- Add button: `p-1 rounded-[3px] hover:bg-slate-200`

**Empty State:**
- Dashed border: `border border-dashed border-slate-200`
- Height: `h-20`
- Text: `text-[11px] text-slate-400`

### Modals (Task, Project, Agent Team)

**Structure:**
```
┌─────────────────────────────┐
│ Title                  [×]  │  ← Header with close button
├─────────────────────────────┤
│                             │
│   [Form fields]             │
│                             │
├─────────────────────────────┤
│              Cancel  Save   │  ← Footer with actions
└─────────────────────────────┘
```

**Styling:**
- Overlay: `bg-slate-900/20 backdrop-blur-[2px]`
- Modal: `bg-white border border-slate-200 rounded-[6px]`
- Shadow: `shadow-[0_8px_24px_rgba(0,0,0,0.08)]`
- Width: `max-w-md` (448px)

**Header:**
- Border: `border-b border-slate-200`
- Title: `text-[13px] font-semibold text-slate-900`
- Close button: `p-1 rounded-[3px] hover:bg-slate-100`

**Form Fields:**
- Input: `px-2.5 py-2 bg-white border border-slate-200 rounded-[4px]`
- Focus: `focus:border-slate-400 focus:ring-1 focus:ring-slate-400/20`
- Label: `text-[11px] font-medium text-slate-500 uppercase tracking-wide`
- Mono font for path fields: `font-mono`

**Priority Selector:**
- Grid: `grid grid-cols-4 gap-1.5`
- Buttons: `px-2 py-1.5 rounded-[4px] border text-[11px] font-medium`
- Active states with semantic colors:
  - Low: `border-slate-400 bg-slate-50`
  - Med: `border-blue-500 bg-blue-50 text-blue-700`
  - High: `border-amber-500 bg-amber-50 text-amber-700`
  - Urgent: `border-red-500 bg-red-50 text-red-700`

**Actions:**
- Cancel: `px-3 py-1.5 rounded-[4px] border border-slate-200 text-slate-600 hover:bg-slate-50`
- Save: `px-3 py-1.5 rounded-[4px] bg-slate-900 text-white hover:bg-slate-800`

### Header

**Structure:**
```
┌─────────────────────────────────────────────────────────────┐
│ [Logo] Kanban Agent Board  [● Connected]  [📁 Project ▼]   │
│                                              [Team] [+ New] │
└─────────────────────────────────────────────────────────────┘
```

**Styling:**
- Background: `bg-white`
- Border: `border-b border-slate-200`
- Padding: `px-4 py-2.5`
- Sticky: `sticky top-0 z-40`

**Logo:**
- Icon: `w-7 h-7 rounded-[4px] bg-slate-900`
- Title: `text-[13px] font-semibold text-slate-900`
- Subtitle: `text-[10px] text-slate-500`

**Connection Status:**
- Connected: `bg-emerald-50 text-emerald-700 border border-emerald-200`
- Demo: `bg-amber-50 text-amber-700 border border-amber-200`
- Size: `text-[10px] font-medium px-2 py-0.5 rounded-[3px]`

**Project Selector:**
- Button: `px-3 py-1.5 rounded-[4px] border border-slate-200 hover:border-slate-300`
- Dropdown: `w-72 bg-white border border-slate-200 rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.08)]`
- Active project: `bg-slate-100 border border-slate-200`
- Hover: `hover:bg-slate-50`

**Action Buttons:**
- Team: `px-2.5 py-1.5 rounded-[4px] border border-slate-200 hover:border-slate-300`
- New task: `px-2.5 py-1.5 rounded-[4px] bg-slate-900 text-white hover:bg-slate-800`
- Keyboard hint: `<kbd>` element with mono font

## Typography Scale

| Element | Size | Weight | Font | Color |
|---------|------|--------|------|-------|
| Page title | 13px | 600 | Inter | slate-900 |
| Subtitle | 10px | 400 | Inter | slate-500 |
| Column title | 13px | 600 | Inter | slate-900 |
| Task title | 13px | 500 | Inter | slate-900 |
| Task description | 11px | 400 | Inter | slate-500 |
| Issue ID | 10px | 400 | JetBrains Mono | slate-500 |
| Priority label | 10px | 500 | Inter | semantic |
| Agent name | 11px | 500 | Inter | slate-600 |
| Button text | 11-12px | 500 | Inter | slate-700/white |
| Badge/count | 10-11px | 400-500 | JetBrains Mono | slate-500/600 |
| Keyboard hint | 10px | 400 | JetBrains Mono | slate-600 |

## Spacing System

| Element | Padding | Margin | Gap |
|---------|---------|--------|-----|
| Page | 16px (p-4) | - | - |
| Header | 16px horizontal, 10px vertical | - | - |
| Column | 8px (p-2) | 12px gap | - |
| Card | 10px (p-2.5) | 8px bottom | - |
| Modal | 16px (p-4) | - | 12px between fields |
| Button | 8-12px horizontal, 6-8px vertical | - | 6-8px between buttons |
| Icon + text | - | - | 6-8px |

## Border Radius

| Element | Radius |
|---------|--------|
| Card | 6px |
| Column | 6px |
| Modal | 6px |
| Button | 4px |
| Input | 4px |
| Badge/pill | 3-4px |
| Agent avatar | 3px |
| Status dot | full (9999px) |

## Shadows

| Context | Shadow |
|---------|--------|
| Default | None |
| Hover | `0 1px 2px rgba(0,0,0,0.04)` |
| Drag | `0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04)` |
| Modal | `0 8px 24px rgba(0,0,0,0.08)` |
| Dropdown | `0 8px 24px rgba(0,0,0,0.08)` |

## Transitions

| Element | Duration | Easing |
|---------|----------|--------|
| All interactive | 150ms | default |
| Hover states | 150ms | default |
| Drag overlay | 150ms | default |
| Modal fade | 150ms | ease-out |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `N` | New task |
| `P` | New project |
| `⌘↵` | Start task (shown in UI) |

## Accessibility

- Focus rings: `focus-ring:focus-visible` with 2px slate-900 outline
- Contrast ratios: All text meets WCAG AA standards
- Keyboard navigation: All interactive elements focusable
- Screen reader: Semantic HTML with proper labels

## Performance

- Minimal shadows reduce paint cost
- Compact sizing reduces scroll distance
- Lazy loading for agent list
- LocalStorage for instant data persistence

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- CSS features: backdrop-filter, custom properties
- Fallbacks: Solid backgrounds for browsers without backdrop-filter

## Design Tokens Summary

```css
/* Colors */
--color-bg-primary: #FFFFFF;
--color-bg-secondary: #F8FAFC;
--color-border: #E2E8F0;
--color-text-primary: #0F172A;
--color-text-secondary: #334155;
--color-text-muted: #64748B;

/* Spacing */
--spacing-xs: 4px;
--spacing-sm: 8px;
--spacing-md: 12px;
--spacing-lg: 16px;

/* Radius */
--radius-sm: 3px;
--radius-md: 4px;
--radius-lg: 6px;

/* Shadows */
--shadow-none: none;
--shadow-hover: 0 1px 2px rgba(0,0,0,0.04);
--shadow-drag: 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04);
--shadow-modal: 0 8px 24px rgba(0,0,0,0.08);
```

## Conclusion

This minimalist design system prioritizes:
1. **Speed** - Compact layout enables rapid scanning
2. **Clarity** - High contrast and semantic colors reduce cognitive load
3. **Precision** - 1px borders and tight geometry feel engineered, not designed
4. **Keyboard-first** - Shortcuts and hints for power users
5. **Density** - Maximum information per screen without clutter

The result is a professional, developer-focused interface that feels like a precision tool rather than a consumer app.

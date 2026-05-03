# Skul Logo Evaluation Checklist

## Intent

This checklist evaluates whether the logo still represents Skul's actual product behavior:

- one source bundle
- translation into multiple tool-native targets
- local-only materialization
- exclusion from Git history

## Checklist

- [x] The icon has a single primary metaphor: a central bundle distributing into several destinations.
- [x] The icon references Skul's multi-tool behavior instead of reading like a generic archive, package, or deployment logo.
- [x] The icon suggests local-only or excluded state with a visible boundary break instead of implying cloud sync or publishing.
- [x] The icon stays recognizable at small sizes because the silhouette is driven by large shapes before details.
- [x] The icon works on light backgrounds without requiring surrounding UI chrome.
- [x] The icon has enough contrast between boundary, bundle, and endpoints.
- [x] Accent colors are limited and purposeful: teal for managed content, amber for tool targets, coral for the excluded boundary marker.
- [x] The SVG includes embedded `title` and `desc` metadata, and any inline app usage can supply host-side `alt` or `aria-label` semantics as needed.
- [x] The composition is symmetric enough to feel tool-like, but not so rigid that it becomes indistinguishable from infrastructure clip art.
- [x] The mark does not overfit to any one supported tool vendor.

## Maintainer Notes

- The center cube is the reusable bundle source.
- The four terminal blocks stand for the tool-native destinations Skul writes into.
- The broken rounded boundary represents repo-local materialization rather than committed project content.
- The coral dot at the gap acts as the "excluded from Git" signal.
- The file includes descriptive metadata, but consuming apps still own the final accessibility contract when they embed the asset.

## Revision Log

### Pass 1

- Strengths: the icon clearly communicates bundle distribution and local boundary.
- Risk: the outer frame and exclusion marker may compete slightly with the center shape.
- Decision: render and inspect before finalizing; simplify if the frame dominates at small sizes.

### Pass 2

- Change made: removed the stray left-side boundary stub and reduced the top-right frame segment to keep the exclusion gap intentional.
- Result: the silhouette is cleaner and the central bundle remains dominant.
- Final decision: accepted.

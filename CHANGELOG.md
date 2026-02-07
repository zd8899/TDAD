# Changelog

All notable changes to the TDAD extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.18] - 2026-02-07

### Fixed
- **Node status display**: Fixed critical issue where nodes showed incorrect status (all grey/pending) until clicked. Implemented single source of truth for file status with new fields (hasBddSpec, hasTestDetails, bddHasRealContent, testHasRealContent) stored directly in node data. Added FileStatusSyncService with file system watchers for automatic status updates when files change. Status now persists across reloads and displays correctly for all nodes immediately without user interaction.

### Changed
- Removed frontend nodeFileStatus Map to eliminate duplicate state
- Updated backend handlers (BddSpecHandlers, TestGenerationHandlers, TestExecutionHandlers) to set status fields when files are created/modified
- Refactored UI components (TDADNode, canvas-app) to read status directly from node fields
- Simplified nodeConverters and useCanvasMessages by removing file status tracking logic

## [0.0.17] - 2026-02-07

### Fixed
- **Critical**: Test ID auto-assignment now supports 4+ digit IDs (1000+). Previously, ID patterns only matched exactly 3 digits (`\d{3}`), causing auto-assignment to fail when test IDs exceeded 999, resulting in duplicate IDs and broken test tracking. Updated all ID patterns to `\d+` to match any number of digits, ensuring the system scales properly for large test suites.

## [0.0.16] - 2026-02-06

### Added
- `folderPath` field to automation state nodes for better readability when working with nested folders

### Changed
- Modes object now displays on a single line in automation-state.json for cleaner formatting
- Test output paths are now cleaner with redundant folder names removed

### Fixed
- Test output now shows proper [API-xxx] tags for API tests (was incorrectly showing [UI] tag)

## [0.0.15] - 2026-02-06

### Added
- Autopilot now skips already-passed nodes during batch automation, significantly improving execution time by avoiding redundant test runs

## [0.0.14] - 2026-02-05

### Fixed
- Test generation prompt now enforces API round-trip verification (every mutation independently verified with a follow-up GET instead of trusting the response)

## [0.0.13] - 2026-02-05

### Fixed
- Auto-run-all mode now respects folder execution order (folder-level edges are now properly resolved into feature-node edges for topological sort)

## [0.0.12] - 2026-02-04

### Changed
- Refactored update-review process to backup all files and open diffs concurrently

## [0.0.11] - 2026-02-04

### Added
- CLI driver dropdown to Autopilot dialog for selecting CLI providers
- Enhanced API testing and logging capabilities

### Changed
- Refactored template update handling and improved accessibility tree capture
- Updated blueprint generation guidelines and feature node definitions
- Improved stylesheet reference in webview for styling consistency

### Fixed
- CLI settings not applied: settings now saved before automation starts
- CLI overrides from Autopilot dialog properly wired to backend

## [0.0.9] - 2026-01-30

### Added
- Slack Remote Control with Edit Feature modal for easy feature modification
- Automation progress notifications via Slack for real-time updates
- GIF demonstrations in Slack documentation for visual guidance
- Enhanced Home Tab interface for centralized Slack controls

### Changed
- Refactored Slack slash commands to Home Tab for improved user experience
- Removed legacy slash command and CLI modal in favor of unified interface

### Fixed
- Resolved duplicate onStopAutomation prop in UnifiedBottomBar component

## [0.0.8] - 2026-01-26

### Added
- TDAD test fixtures for enhanced trace capture and reporting
- Improved debugging capabilities with comprehensive trace data

## [0.0.7] - 2026-01-16

### Changed
- Patch release for marketplace update
- Stability improvements and bug fixes

## [0.0.6] - 2026-01-14

### Changed
- Patch release for marketplace publication
- Minor bug fixes and stability improvements

## [0.0.5] - 2026-01-14

### Changed
- Marketplace release with proper CHANGELOG documentation
- Prepared for dual marketplace publication (Open VSX + Microsoft)

## [0.0.4] - 2026-01-14

### Added
- Auto-Pilot feature (Closed Beta) - Automated BDD → Test → Fix workflow orchestration
- Enhanced golden packet with comprehensive debugging data and trace capture
- Project Wizard with two workflows: Start New Project and Map Existing Codebase
- Visual Canvas system for workflow management with hierarchical folder organization
- Dependency system for reusing actions across features
- Centralized trace capture via TDAD fixtures
- Support for multiple AI providers (OpenAI, Anthropic, Google, Cohere)

### Changed
- Updated package description to emphasize Auto-Pilot feature
- Enhanced README with detailed feature documentation and installation instructions
- Improved icon visual assets

### Fixed
- Test violation guidelines in golden packet
- Playwright usage guidelines clarification

## [0.0.3] - Previous Release

### Added
- Initial Canvas implementation
- Basic BDD workflow support
- Playwright test integration

## [0.0.2] - Previous Release

### Added
- Core workflow engine
- Node-based architecture

## [0.0.1] - Initial Release

### Added
- Basic extension scaffold
- Initial project structure

export interface Test {
    id: string;
    featureId: string;
    title: string;
    description: string;
    input: any;
    expectedResult: any;
    sortOrder?: number;
    createdAt?: string;
}

export interface Feature {
    id: string;
    nodeId: string;
    description: string;
    sortOrder?: number;
    createdAt?: string;
    tests?: Test[]; // Optional: populated when loading from test files
}

// Node Types for different structures
export type NodeType = 'folder' | 'file' | 'function';

// Test execution status
export type TestStatus = 'passed' | 'failed' | 'pending' | 'not_tested';

// Base Node interface (shared fields for all node types)
export interface BaseNode {
    id: string;
    workflowId: string;
    nodeType: NodeType; // NEW: Identifies the node type
    title: string;
    description: string;
    position?: { x: number; y: number };
    parentId?: string; // NEW: Reference to parent node (for hierarchy)
    contextFiles?: string[]; // Files that provide context for AI code generation
    isGhost?: boolean; // Sprint 9: Visual flag for cross-folder dependencies
    testLayers?: ('ui' | 'api')[]; // Node-level override: which test layers to generate (default: use global settings)
    createdAt?: string;
    updatedAt?: string;

    // Runtime properties (populated during automation)
    testCodeFile?: string; // Path to generated test file
    planFile?: string; // Path to BDD plan/spec file
    lastTestResults?: TestResult[]; // Results from last test run
    sourceFile?: string; // Path to generated source/action file
}

// Folder Node - represents an actual directory
export interface FolderNode extends BaseNode {
    nodeType: 'folder';
    folderPath: string; // Path to the directory (e.g., "src/services")
    children?: string[]; // IDs of child nodes (files and subfolders)
    status?: TestStatus; // Aggregated status from child nodes
    dependencies?: string[]; // Sprint 7: IDs of nodes this folder depends on
    dependents?: string[]; // Sprint 7: IDs of nodes that depend on this folder
}

// File Node - represents an actual code file
export interface FileNode extends BaseNode {
    nodeType: 'file';
    filePath: string; // Full path to file (e.g., "src/services/auth.ts")
    language: string; // Language/type (typescript, javascript, python, etc.)
    fileName?: string; // Auto-generated file name
    preConditions: string[];
    features: Feature[]; // File-level features with tests
    testData: any;
    status?: 'pending' | 'tests-ready' | 'generating' | 'testing' | 'passed' | 'failed';
    generatedFilePath?: string;
    actionFile?: string; // Sprint 9: Separate action file
    actionType?: 'ui' | 'api' | 'db'; // Sprint 9: Action type
    children?: string[]; // IDs of function nodes in this file
    dependencies?: string[]; // IDs of nodes this node depends on
    dependents?: string[]; // IDs of nodes that depend on this node
    dependencyType?: 'local' | 'remote'; // Sprint 9: Local (same folder) or Remote (ghost node)
    originalWorkflowId?: string; // Sprint 9: For ghost nodes, where they originally come from

    testFramework?: string; // Test framework to use (e.g., "jest", "pytest", "vitest")
    lastTestRunId?: string; // Reference to most recent TestHistory entry

    // Sprint 7: Input/Output System
    inputs?: NodeInput[]; // Test data requirements
    outputs?: NodeOutput[]; // Test data produced
}

// Function Node - represents a function/class/method in a file
export interface FunctionNode extends BaseNode {
    nodeType: 'function';
    functionName: string; // Exact name in code (e.g., "validateUser")
    functionSignature?: string; // Parameters and return type
    parentFileId: string; // Reference to parent file node
    preConditions: string[];
    features: Feature[]; // Function-specific features with tests
    testData: any;
    status?: 'pending' | 'tests-ready' | 'generating' | 'testing' | 'passed' | 'failed';
    startLine?: number; // Line number where function starts in file
    endLine?: number; // Line number where function ends in file
    actionFile?: string; // Sprint 9: Separate action file
    actionType?: 'ui' | 'api' | 'db'; // Sprint 9: Action type
    dependencies?: string[]; // Sprint 7: IDs of nodes this function depends on
    dependents?: string[]; // Sprint 7: IDs of nodes that depend on this function

    isExported?: boolean; // Whether function is exported from file
    lastTestRunId?: string; // Reference to most recent TestHistory entry

    // Sprint 7: Input/Output System
    inputs?: NodeInput[]; // Test data requirements
    outputs?: NodeOutput[]; // Test data produced
}

// Node Input/Output Types (Sprint 7: Input/Output Node System)
export interface NodeInput {
    id: string;
    name: string;              // e.g., "authToken", "userId"
    type: 'string' | 'object' | 'number' | 'boolean' | 'array';
    required: boolean;
    description?: string;      // Help text for users
    source: {
        type: 'node' | 'manual' | 'mock';
        nodeId?: string;       // If source type is 'node'
        outputName?: string;   // Which output from that node
        value?: any;           // If source type is 'manual'
        executionMode?: 'execute' | 'static';  // Default: 'execute' (always run), 'static' (use saved data with fallback)
    };
}

export interface NodeOutput {
    id: string;
    name: string;              // e.g., "authToken", "userId"
    type: 'string' | 'object' | 'number' | 'boolean' | 'array';
    description?: string;      // Help text for users
    value?: any;              // Captured after test runs
    capturedAt?: string;      // ISO timestamp when captured
}

// Union type for all node types
export type Node = FolderNode | FileNode | FunctionNode;

// Sprint 5: Enhanced coverage data structures
export interface ApiRequest {
    url: string;
    method: string;
    status: number;
    requestBody?: any;      // What was sent to the API
    responseBody?: any;     // What was received from the API
    contentType?: string;   // Content-Type header
    duration?: number;      // Response time in ms
    error?: string;         // Legacy field for backward compatibility
}

// Console log captured during test execution
export interface ConsoleLog {
    type: 'log' | 'warn' | 'error' | 'info' | 'debug';
    text: string;
    location?: string;  // file:line if available
    timestamp: number;
}

// Uncaught JavaScript error captured during test execution
export interface PageError {
    message: string;
    stack?: string;
    timestamp: number;
}

// Per-test trace data
export interface TestTrace {
    status: 'passed' | 'failed' | 'timedOut' | 'skipped';
    apiRequests: ApiRequest[];
    consoleLogs: ConsoleLog[];
    pageErrors: PageError[];
    actionResult?: any;  // Return value from action function (e.g., { success: false, errorMessage: "..." })
    screenshotPath?: string;  // Relative path to screenshot file
}

export interface CoverageData {
    sourceFiles: string[];
    inferredBackendFiles: string[];
    testTraces: { [testTitle: string]: TestTrace };  // Per-test trace data
}

export interface TestResult {
    test: Test;
    passed: boolean;
    actualResult?: any;
    error?: string;
    fullError?: string; // Full error message with stack trace
    coverageData?: CoverageData; // Enhanced coverage with source files and API requests
}

export interface Edge {
    id: string;
    source: string;
    target: string;
    type?: 'import' | 'call' | 'data' | 'dependency' | 'execution'; // NEW: Added import, call, data types
    label?: string;
    dataType?: string; // NEW: Type of data being passed
    isRequired?: boolean; // NEW: Whether connection is required
    animated?: boolean;
    style?: any;
}

export interface WorkflowState {
    nodes: Node[];
    edges: Edge[];
    version: string;
    name?: string;
    description?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface TestHistory {
    id: string;
    nodeId: string;
    workflowId: string;
    executedAt: string;
    duration: number; // milliseconds
    totalTests: number;
    passedTests: number;
    failedTests: number;
    passRate: number; // 0-100
    results: TestResult[];
    modelUsed?: string; // Which AI model generated the code
    codeVersion?: string; // Hash or version of the code tested
    exitCode: number | null;
    timedOut: boolean;
    error?: string;
}

// Tech Stack Configuration
export interface TechStack {
    languages: string[]; // e.g., ["TypeScript", "JavaScript"]
    frameworks: string[]; // e.g., ["React", "Express"]
    libraries: string[]; // e.g., ["axios", "lodash"]
    tools: string[]; // e.g., ["webpack", "jest"]
    database?: string; // e.g., "PostgreSQL", "MongoDB"
    architecture?: string; // e.g., "MVC", "Clean Architecture"
}

/**
 * Test generation settings - configurable via Settings dialog
 * Uses Playwright exclusively for UI and API tests (no unit tests)
 */
export interface TestSettings {
    types: string[];          // ui, api (Playwright only)
    coverage: boolean;        // Include coverage in test runs
    workers: number;          // Playwright workers count (default: 1 to prevent race conditions)
}

/**
 * CLI-specific permission/automation flags
 */
export interface CLIPermissionFlags {
    claude: {
        dangerouslySkipPermissions: boolean;  // --dangerously-skip-permissions
    };
    aider: {
        yesAlways: boolean;                   // --yes (auto-confirm prompts)
        autoCommit: boolean;                  // --auto-commits (auto-commit changes)
    };
    codex: {
        autoApprove: boolean;                 // --auto-approve (approve all changes)
    };
}

/**
 * CLI/Autopilot settings for hands-free automation
 */
export interface CLISettings {
    enabled: boolean;         // Auto-trigger CLI agent
    command: string;          // CLI command template with {file} and {prompt} placeholders
    permissionFlags: CLIPermissionFlags;  // CLI-specific automation flags
}

/**
 * Project Context - Source of truth for project configuration
 * Persisted from Project Wizard choices
 */
export interface ProjectContext {
    techStack: string;
    techStackCustom?: string;
    projectType: string;
    projectTypeCustom?: string;
    database: string;
    databaseCustom?: string;
    sourceRoot: string;
    docsRoot: string;
}

/**
 * Autopilot automation modes
 */
export type AutopilotModes = ('bdd' | 'test' | 'run-fix')[];

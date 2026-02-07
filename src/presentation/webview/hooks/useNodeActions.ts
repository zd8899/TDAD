/**
 * useNodeActions - Custom hook for node action handlers
 *
 * Provides handlers for bottom action bar and node floating buttons.
 * Extracted from useFeatureEditorHandlers for the new UI architecture.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Node, NodeInput, NodeOutput } from '../../../shared/types';
import { getWorkflowFolderName } from '../../../shared/utils/stringUtils';
import { getFeatureFilePath, getTestFilePath, getActionFilePath } from '../../../shared/utils/nodePathUtils';

export interface NodeActionsState {
    // Loading indicators
    isGeneratingBdd: boolean;
    isSavingSpec: boolean;
    isGeneratingTest: boolean;
    isRunningTest: boolean;
    isCopyingGoldenPacket: boolean;
    isRunningAutomation: boolean;
    automationPhase: string | null;

    // File paths
    bddSpecFilePath: string | null;
    testCodeFilePath: string | null;
    actionCodeFilePath: string | null;

    // Content
    featureDescription: string;
    bddSpec: string;
    contextFiles: string[];

    // Test details
    testDetails: Array<{ title: string; input: string; expectedResult: string; actualResult?: string; status: string }>;

    // File content status - true if file has real content (not default scaffold)
    bddHasRealContent: boolean;
    testHasRealContent: boolean;

    // Test error
    testError: string;

    // All nodes for dependency picker
    allWorkflowNodes: Node[];
}

export interface NodeActionsHandlers {
    handleCopyBddPrompt: () => void;
    handleSaveBddSpec: (bddSpec: string) => void;
    handleGenerateTestCode: () => void;
    handleRunTest: () => void;
    handleCopyGoldenPacket: () => void;
    handleSaveDescription: (description: string) => void;
    handleAddContextFile: () => void;
    handleRemoveContextFile: (filePath: string) => void;
    handleAddDependency: (selectedNodeIds: string[]) => void;
    handleOpenFile: (filePath: string) => void;
    handleRunAutomation: () => void;
}

export type NotificationCallback = (message: string, subMessage?: string, type?: 'success' | 'info' | 'warning' | 'error') => void;

// Helper functions to detect default scaffold content
const isDefaultBddContent = (content: string): boolean => {
    return content.includes('# TODO: Add more scenarios based on requirements');
};

const isDefaultTestContent = (content: string): boolean => {
    return content.includes("throw new Error('Test not implemented yet')");
};

export function useNodeActions(
    node: Node | undefined,
    postMessage?: (message: any) => void,
    edges: Array<{ id: string; source: string; target: string }> = [],
    onNotification?: NotificationCallback
): [NodeActionsState, NodeActionsHandlers] {
    // Loading states
    const [isGeneratingBdd, setIsGeneratingBdd] = useState(false);
    const [isSavingSpec, setIsSavingSpec] = useState(false);
    const [isGeneratingTest, setIsGeneratingTest] = useState(false);
    const [isRunningTest, setIsRunningTest] = useState(false);
    const [isCopyingGoldenPacket, setIsCopyingGoldenPacket] = useState(false);
    const [isRunningAutomation, setIsRunningAutomation] = useState(false);
    const [automationPhase, setAutomationPhase] = useState<string | null>(null);

    // File paths
    const [bddSpecFilePath, setBddSpecFilePath] = useState<string | null>(null);
    const [testCodeFilePath, setTestCodeFilePath] = useState<string | null>(null);
    const [actionCodeFilePath, setActionCodeFilePath] = useState<string | null>(null);

    // Content
    const [featureDescription, setFeatureDescription] = useState('');
    const [bddSpec, setBddSpec] = useState('');
    const [contextFiles, setContextFiles] = useState<string[]>([]);

    // Test details
    const [testDetails, setTestDetails] = useState<Array<{ title: string; input: string; expectedResult: string; actualResult?: string; status: string }>>([]);

    // Raw test file content (for default detection)
    const [testFileContent, setTestFileContent] = useState<string>('');

    // Test error
    const [testError, setTestError] = useState<string>('');

    // All nodes for dependency picker
    const [allWorkflowNodes, setAllWorkflowNodes] = useState<Node[]>([]);

    // Computed: Check if content is real (not default scaffold)
    const bddHasRealContent = bddSpec.length > 0 && !isDefaultBddContent(bddSpec);
    const testHasRealContent = testFileContent.length > 0 && !isDefaultTestContent(testFileContent);

    // Use ref for postMessage to avoid infinite loops
    const postMessageRef = useRef(postMessage);
    postMessageRef.current = postMessage;

    // Load data when node changes
    useEffect(() => {
        if (!node) { return; }

        // Skip all processing for folder nodes - they don't have feature workflow files
        if (node.nodeType === 'folder') {
            // Reset state for folders
            setFeatureDescription(node.description || '');
            setContextFiles([]);
            setTestDetails([]);
            setBddSpecFilePath(null);
            setTestCodeFilePath(null);
            setActionCodeFilePath(null);
            setBddSpec('');
            return;
        }

        // Reset state when node changes
        setFeatureDescription(node.description || '');
        setContextFiles(node.contextFiles || []);
        setTestDetails((node as any).testDetails || []);
        setTestError('');
        setIsRunningAutomation(false);
        setAutomationPhase(null);

        // Build file paths - fileName must be set in workflow.json (no fallback)
        const fileName = node.fileName;
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const specPath = getFeatureFilePath(workflowFolderName, fileName);
        setBddSpecFilePath(specPath);

        const testPath = getTestFilePath(workflowFolderName, fileName);
        setTestCodeFilePath(testPath);

        const actionPath = getActionFilePath(workflowFolderName, fileName);
        setActionCodeFilePath((node as any).actionFile || actionPath);

        // Request to load BDD spec content from file
        setBddSpec('');
        setTestFileContent('');
        if (postMessageRef.current) {
            postMessageRef.current({
                command: 'loadBddSpec',
                nodeId: node.id,
                filePath: specPath
            });

            postMessageRef.current({
                command: 'loadTestDetails',
                nodeId: node.id,
                testFilePath: testPath
            });

            // Request raw test file content for default detection
            postMessageRef.current({
                command: 'loadTestFileContent',
                nodeId: node.id,
                filePath: testPath
            });

            postMessageRef.current({
                command: 'requestAllNodes',
                workflowId: node.workflowId
            });
        }
    }, [node?.id]);

    // Listen for messages from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;

            switch (message.command) {
                case 'bddSpecLoaded':
                    if (message.nodeId === node?.id && message.gherkinSpec) {
                        setBddSpec(message.gherkinSpec);
                    }
                    break;
                case 'bddPromptCopied':
                    if (message.nodeId === node?.id) {
                        setIsGeneratingBdd(false);
                        if (message.bddSpecFilePath) {
                            setBddSpecFilePath(message.bddSpecFilePath);
                        }
                        // Show canvas notification
                        if (onNotification) {
                            onNotification(
                                'Plan folder created. Prompt copied! Paste it to your AI Agent',
                                message.bddSpecFilePath || undefined,
                                'success'
                            );
                        }
                    }
                    break;
                case 'bddSpecSaved':
                    if (message.nodeId === node?.id && message.filePath) {
                        setBddSpecFilePath(message.filePath);
                        if (message.gherkinSpec) {
                            setBddSpec(message.gherkinSpec);
                        }
                    }
                    break;
                case 'testCodeGenerated':
                    if (message.nodeId === node?.id) {
                        setIsGeneratingTest(false);
                        if (message.testFilePath) {
                            setTestCodeFilePath(message.testFilePath);
                            const actionPath = message.testFilePath.replace('.test.js', '.action.js');
                            setActionCodeFilePath(actionPath);
                        }
                        if (message.testDetails) {
                            setTestDetails(message.testDetails);
                        }
                        // Show canvas notification
                        if (onNotification) {
                            onNotification(
                                'Test files scaffolded. Prompt copied! Paste it to your AI Agent',
                                message.testFilePath || undefined,
                                'success'
                            );
                        }
                    }
                    break;
                case 'testDetailsLoaded':
                    if (message.nodeId === node?.id && message.testDetails && message.testDetails.length > 0) {
                        // Only update if we don't already have test results with pass/fail status
                        // This prevents race condition where testDetailsLoaded overwrites testResultsUpdated
                        setTestDetails(prev => {
                            const hasTestResults = prev.some(t => t.status === 'passed' || t.status === 'failed');
                            if (hasTestResults) {
                                // Merge: keep pass/fail status from previous results, add any new tests from file
                                const prevMap = new Map(prev.map(t => [t.title, t]));
                                return message.testDetails.map((loaded: any) => {
                                    const existing = prevMap.get(loaded.title);
                                    if (existing && (existing.status === 'passed' || existing.status === 'failed')) {
                                        return existing; // Keep existing result with pass/fail status
                                    }
                                    return loaded; // Use loaded (pending) for new/unrun tests
                                });
                            }
                            return message.testDetails; // No results yet, use loaded details
                        });
                    }
                    break;
                case 'testFileContentLoaded':
                    if (message.nodeId === node?.id && message.content !== undefined) {
                        setTestFileContent(message.content);
                    }
                    break;
                case 'testResultsUpdated':
                    if (message.nodeId === node?.id) {
                        setIsRunningTest(false);
                        if (message.testError) { setTestError(message.testError); }

                        // Update test details with results
                        if (message.testResults && Array.isArray(message.testResults)) {
                             const updatedDetails = message.testResults.map((result: any) => {
                                 let actual = result.actualResult;
                                 // Handle actual result formatting
                                 if (actual === undefined || actual === null) {
                                     actual = '';
                                 } else if (typeof actual === 'object') {
                                     try {
                                         actual = JSON.stringify(actual, null, 2);
                                     } catch (e) {
                                         actual = String(actual);
                                     }
                                 } else {
                                     actual = String(actual);
                                 }

                                 return {
                                     title: result.test?.title || 'Unknown Test',
                                     input: result.test?.input ? (typeof result.test.input === 'object' ? JSON.stringify(result.test.input, null, 2) : String(result.test.input)) : '',
                                     expectedResult: result.test?.expectedResult ? (typeof result.test.expectedResult === 'object' ? JSON.stringify(result.test.expectedResult, null, 2) : String(result.test.expectedResult)) : '',
                                     actualResult: actual,
                                     status: result.passed ? 'passed' : 'failed'
                                 };
                             });
                             setTestDetails(updatedDetails);
                        }

                        // Show canvas notification
                        if (onNotification) {
                            const passed = message.passed;
                            const testResults = message.testResults || [];
                            const passedCount = testResults.filter((r: any) => r.passed).length;
                            const totalCount = testResults.length;
                            if (passed) {
                                onNotification(
                                    `All tests passed (${passedCount}/${totalCount})`,
                                    undefined,
                                    'success'
                                );
                            } else if (totalCount > 0) {
                                onNotification(
                                    `Tests completed: ${passedCount}/${totalCount} passed`,
                                    undefined,
                                    'warning'
                                );
                            }
                        }
                    }
                    break;
                case 'contextFilesAdded':
                    if (message.nodeId === node?.id && message.contextFiles) {
                        setContextFiles(message.contextFiles);
                    }
                    break;
                case 'nodeUpdated':
                    if (message.node && message.node.id === node?.id) {
                        if (message.node.contextFiles !== undefined) {
                            setContextFiles(message.node.contextFiles || []);
                        }
                    }
                    break;
                case 'allNodesLoaded':
                    if (message.nodes) {
                        setAllWorkflowNodes(message.nodes);
                    }
                    break;

                // Handle errors - reset all loading states
                case 'error':
                    setIsGeneratingBdd(false);
                    setIsGeneratingTest(false);
                    setIsRunningTest(false);
                    setIsCopyingGoldenPacket(false);
                    setIsRunningAutomation(false);
                    break;

                // Handle test error specifically
                case 'testError':
                    if (message.nodeId === node?.id) {
                        setIsRunningTest(false);
                    }
                    break;

                // Single-node automation messages
                case 'singleNodeAutomationStatus':
                    if (message.nodeId === node?.id) {
                        setIsRunningAutomation(message.status === 'running');
                        setAutomationPhase(message.phase || null);
                    }
                    break;

                case 'singleNodeAutomationComplete':
                    // Always reset automation state when any automation completes
                    // Backend prevents multiple simultaneous automations, so this is safe
                    // Without this, button stays disabled if user deselects node during automation
                    setIsRunningAutomation(false);
                    setAutomationPhase(null);
                    if (message.nodeId === node?.id && onNotification) {
                        onNotification(
                            message.passed ? 'Automation complete - All tests passed!' : 'Automation complete - Tests failed',
                            undefined,
                            message.passed ? 'success' : 'warning'
                        );
                    }
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [node?.id, onNotification]);

    // Handlers - use postMessageRef.current to avoid dependency on postMessage
    const handleCopyBddPrompt = useCallback(() => {
        if (!postMessageRef.current || !node) {
            return;
        }

        // Use node.description directly if featureDescription state hasn't been set
        const descToUse = featureDescription.trim() || node.description || '';

        setIsGeneratingBdd(true);
        postMessageRef.current({
            command: 'copyBddPrompt',
            nodeId: node.id,
            workflowId: node.workflowId,
            featureDescription: descToUse
        });
    }, [node, featureDescription]);

    const handleSaveBddSpec = useCallback((specContent: string) => {
        if (!postMessageRef.current || !node || !specContent.trim()) {
            return;
        }

        setIsSavingSpec(true);
        postMessageRef.current({
            command: 'saveBddSpec',
            nodeId: node.id,
            workflowId: node.workflowId,
            bddSpec: specContent,
            filePath: bddSpecFilePath
        });

        setTimeout(() => setIsSavingSpec(false), 1000);
    }, [node, bddSpecFilePath]);

    const handleGenerateTestCode = useCallback(() => {
        if (!postMessageRef.current || !node || !bddSpec.trim()) {
            return;
        }

        setIsGeneratingTest(true);
        postMessageRef.current({
            command: 'generateTestCodeFromGherkin',
            nodeId: node.id,
            workflowId: node.workflowId,
            gherkinSpec: bddSpec,
            testFramework: 'playwright'
        });
    }, [node, bddSpec]);

    const handleRunTest = useCallback(() => {
        if (!postMessageRef.current || !node) {
            return;
        }

        setIsRunningTest(true);
        postMessageRef.current({
            command: 'runTests',
            node
        });

        setTimeout(() => setIsRunningTest(false), 2000);
    }, [node]);

    const handleCopyGoldenPacket = useCallback(() => {
        if (!postMessageRef.current || !node) {
            return;
        }

        setIsCopyingGoldenPacket(true);
        postMessageRef.current({
            command: 'copyGoldenPacket',
            nodeId: node.id,
            workflowId: node.workflowId
        });

        // Show notification (optimistic - backend will show vscode toast on success/error)
        if (onNotification) {
            setTimeout(() => {
                onNotification(
                    'Golden packet copied to clipboard! Paste it to your AI Agent',
                    undefined,
                    'success'
                );
            }, 500);
        }

        setTimeout(() => setIsCopyingGoldenPacket(false), 3000);
    }, [node, onNotification]);

    const handleSaveDescription = useCallback((description: string) => {
        if (!postMessageRef.current || !node) {
            return;
        }

        setFeatureDescription(description);
        postMessageRef.current({
            command: 'updateNode',
            node: {
                ...node,
                description: description
            }
        });
    }, [node]);

    const handleAddContextFile = useCallback(() => {
        if (!postMessageRef.current || !node) {
            return;
        }

        postMessageRef.current({
            command: 'selectContextFiles',
            nodeId: node.id
        });
    }, [node]);

    const handleRemoveContextFile = useCallback((filePath: string) => {
        const updatedFiles = contextFiles.filter(f => f !== filePath);
        setContextFiles(updatedFiles);

        if (postMessageRef.current && node) {
            postMessageRef.current({
                command: 'updateNode',
                node: {
                    ...node,
                    contextFiles: updatedFiles
                }
            });
        }
    }, [node, contextFiles]);

    const handleAddDependency = useCallback((selectedNodeIds: string[]) => {
        if (!postMessageRef.current || !node) {
            return;
        }

        // Get current dependencies from edges (single source of truth)
        const currentDeps = edges.filter(e => e.target === node.id).map(e => e.source);
        const newDeps = selectedNodeIds.filter(id => !currentDeps.includes(id));

        // Add edges for each new dependency
        for (const sourceId of newDeps) {
            postMessageRef.current({
                command: 'addEdge',
                edge: {
                    id: `${sourceId}-${node.id}`,
                    source: sourceId,
                    target: node.id,
                    type: 'custom',
                    animated: false
                }
            });
        }
    }, [node, edges]);

    const handleOpenFile = useCallback((filePath: string) => {
        if (!postMessageRef.current) {
            return;
        }

        postMessageRef.current({
            command: 'openFile',
            filePath: filePath
        });
    }, []);

    const handleRunAutomation = useCallback(() => {
        if (!postMessageRef.current) {
            return;
        }

        // Toggle behavior: if running, stop; otherwise start
        if (isRunningAutomation) {
            postMessageRef.current({
                command: 'stopSingleNodeAutomation'
            });
            setIsRunningAutomation(false);
            setAutomationPhase(null);
        } else {
            if (!node) {
                return;
            }
            setIsRunningAutomation(true);
            postMessageRef.current({
                command: 'runSingleNodeAutomation',
                nodeId: node.id
            });
        }
    }, [node, isRunningAutomation]);

    const state: NodeActionsState = {
        isGeneratingBdd,
        isSavingSpec,
        isGeneratingTest,
        isRunningTest,
        isCopyingGoldenPacket,
        isRunningAutomation,
        automationPhase,
        bddSpecFilePath,
        testCodeFilePath,
        actionCodeFilePath,
        featureDescription,
        bddSpec,
        contextFiles,
        testDetails,
        bddHasRealContent,
        testHasRealContent,
        testError,
        allWorkflowNodes
    };

    const handlers: NodeActionsHandlers = {
        handleCopyBddPrompt,
        handleSaveBddSpec,
        handleGenerateTestCode,
        handleRunTest,
        handleCopyGoldenPacket,
        handleSaveDescription,
        handleAddContextFile,
        handleRemoveContextFile,
        handleAddDependency,
        handleOpenFile,
        handleRunAutomation
    };

    return [state, handlers];
}

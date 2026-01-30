/**
 * featureFormConfig - Shared form field definitions for feature editing
 *
 * Used by both Canvas (NodeForm.tsx) and Slack (SlackModalBuilders.ts)
 * to ensure consistent labels, placeholders, and hints across platforms.
 */

export interface FormFieldConfig {
    label: string;
    placeholder: string;
    hint?: string;
}

export interface TestLayerOption {
    value: string;
    label: string;
    slackLabel: string; // Shorter label for Slack (max 75 chars)
}

/**
 * Feature form field configurations
 */
export const featureFormFields = {
    title: {
        label: 'Feature Name',
        placeholder: 'e.g., User Login, Shopping Cart, File Upload',
        hint: 'A clear, descriptive name for this feature'
    } as FormFieldConfig,

    description: {
        label: 'Feature Description',
        placeholder: `Write a clear description of what this feature should accomplish. This will be used to generate the plan and test code.

Example: As a user, I need to be able to log in with username and password. The system should validate credentials against the database and create a session.`,
        hint: 'Describe what this feature should do - be specific for better AI generation'
    } as FormFieldConfig,

    testLayers: {
        label: 'Test Layers',
        placeholder: '',
        hint: 'Override global test settings for this specific feature'
    } as FormFieldConfig,

    contextFiles: {
        label: 'Context Files',
        placeholder: '',
        hint: 'Files that provide context for AI code generation'
    } as FormFieldConfig,

    dependencies: {
        label: 'Dependencies',
        placeholder: '',
        hint: 'Other features this feature depends on'
    } as FormFieldConfig
};

/**
 * Test layer options - used in both canvas dropdown and Slack select
 */
export const testLayerOptions: TestLayerOption[] = [
    { value: 'global', label: 'Use Global Settings', slackLabel: 'Global Settings' },
    { value: 'ui', label: 'UI Only', slackLabel: 'UI Only' },
    { value: 'api', label: 'API Only', slackLabel: 'API Only' },
    { value: 'both', label: 'UI + API', slackLabel: 'UI + API' }
];

/**
 * Convert test layers array to select value
 */
export function testLayersToValue(testLayers: ('ui' | 'api')[] | undefined): string {
    if (!testLayers || testLayers.length === 0) return 'global';
    if (testLayers.includes('ui') && testLayers.includes('api')) return 'both';
    if (testLayers.includes('ui')) return 'ui';
    if (testLayers.includes('api')) return 'api';
    return 'global';
}

/**
 * Convert select value to test layers array
 */
export function valueToTestLayers(value: string): ('ui' | 'api')[] | undefined {
    switch (value) {
        case 'ui': return ['ui'];
        case 'api': return ['api'];
        case 'both': return ['ui', 'api'];
        default: return undefined; // global = use global settings
    }
}

/**
 * Form titles based on mode
 */
export const formTitles = {
    createFeature: 'Create New Feature',
    editFeature: 'Edit Feature',
    createFolder: 'Create New Folder',
    editFolder: 'Edit Folder'
};

/**
 * Button labels
 */
export const buttonLabels = {
    save: 'Save',
    cancel: 'Cancel',
    createFeature: 'Create Feature',
    updateFeature: 'Update Feature',
    createFolder: 'Create Folder',
    updateFolder: 'Update Folder'
};

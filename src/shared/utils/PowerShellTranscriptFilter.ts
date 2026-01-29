/**
 * PowerShellTranscriptFilter - Filters PowerShell Start-Transcript noise
 * Used by CLI output watchers and readers to clean up log content
 */

const TRANSCRIPT_METADATA_PATTERNS = [
    /^Windows PowerShell transcript/i,
    /^Start time:/i,
    /^End time:/i,
    /^Username:/i,
    /^RunAs User:/i,
    /^Configuration Name:/i,
    /^Machine:/i,
    /^Host Application:/i,
    /^Process ID:/i,
    /^PSVersion:/i,
    /^PSEdition:/i,
    /^PSCompatibleVersions:/i,
    /^BuildVersion:/i,
    /^CLRVersion:/i,
    /^WSManStackVersion:/i,
    /^PSRemotingProtocolVersion:/i,
    /^SerializationVersion:/i,
    /^Transcript started/i,
    /^Transcript stopped/i
];

/**
 * Check if a line is PowerShell transcript metadata
 */
function isTranscriptMetadata(line: string): boolean {
    const trimmed = line.trim();
    return TRANSCRIPT_METADATA_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Filter out PowerShell Start-Transcript headers and footers
 * Removes separator lines and metadata, leaving only actual CLI output
 */
export function filterTranscriptNoise(content: string): string {
    // Normalize line endings (Windows CRLF, old Mac CR, Unix LF)
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const filteredLines: string[] = [];

    for (const line of lines) {
        // Skip transcript separator lines
        if (line.trim() === '**********************') {
            continue;
        }

        // Skip known transcript metadata lines
        if (isTranscriptMetadata(line)) {
            continue;
        }

        filteredLines.push(line);
    }

    return filteredLines.join('\n');
}

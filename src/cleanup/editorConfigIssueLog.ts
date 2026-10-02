import { EditorConfigProperties } from './editorconfig';
import type { EditorConfigIssue } from './runCleanup';

/** Unsupported settings already reported in this session, by {@link editorConfigSignature}. */
export interface ReportedConfigurations {
  readonly seen: Set<string>;
  readonly signatureOf: (filePath: string) => string;
}

/**
 * Logs the `.editorconfig` issues of one cleanup run. Violations cleanup could not fix, and the notes
 * of the Code Janitor settings (what they left undone), are logged per file as they come. Unsupported
 * settings are logged when the run finishes, once each, with the number of files they affect. With
 * `session`, the unsupported settings of a configuration already reported in the session are left
 * out (single-file cleanup, cleanup on save, preview).
 */
export class EditorConfigIssueLog {
  private unresolved = 0;
  private notes = 0;
  private readonly filesBySetting = new Map<string, Set<string>>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly session?: ReportedConfigurations
  ) {}

  readonly report = (issue: EditorConfigIssue): void => {
    if (issue.kind === 'unresolved') {
      this.unresolved++;
      this.log(`.editorconfig rule not fixed: ${issue.filePath}: ${issue.detail}`);

      return;
    }

    if (issue.kind === 'note') {
      this.notes++;
      this.log(`Cleanup note: ${issue.filePath}: ${issue.detail}`);

      return;
    }

    const files = this.filesBySetting.get(issue.detail) ?? new Set<string>();
    files.add(issue.filePath);
    this.filesBySetting.set(issue.detail, files);
  };

  /** Logs the unsupported settings; the counts are of violations, of notes and of distinct settings logged. */
  finish(): { unresolved: number; notes: number; unsupported: number } {
    const reported = new Set<string>();
    let unsupported = 0;

    for (const [setting, files] of this.filesBySetting) {
      const fresh = [...files].filter((filePath) => {
        const signature = this.session?.signatureOf(filePath);
        if (signature === undefined) {
          return true;
        }

        reported.add(signature);

        return !this.session!.seen.has(signature);
      });
      if (fresh.length === 0) {
        continue;
      }

      unsupported++;
      this.log(`.editorconfig setting not supported: ${setting} (${fresh.length} ${fresh.length === 1 ? 'file' : 'files'})`);
    }

    reported.forEach((signature) => this.session?.seen.add(signature));
    this.filesBySetting.clear();

    return { unresolved: this.unresolved, notes: this.notes, unsupported };
  }
}

/**
 * Identifies the resolved `.editorconfig` properties of a file, whichever files they come from, and
 * the project's analysis settings (NoWarn, AnalysisLevel/Mode, ...) that decide which of them apply.
 */
export function editorConfigSignature(props: EditorConfigProperties): string {
  const entries = [...props.entries].map(([key, value]) => `${key}=${value}`).sort();

  return [...entries, '[analysis]', props.analysis?.signature ?? 'none'].join('\n');
}

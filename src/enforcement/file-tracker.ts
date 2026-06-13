interface FileEdit {
  file: string;
  turn: number;
}

const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /(^|\/)tests?\//,
  /\/__tests__\//,
  /\/test_\w+\.py$/,
  /(^|\/)conftest\.py$/,
];

const FIXTURE_PATTERNS = [
  /\/fixtures?\//,
  /\/docs?\//,
  /\.md$/,
  /\.ya?ml$/,
  /\.json$/,
];

export class FileTracker {
  private sourceEdits: FileEdit[] = [];
  private testEdits: FileEdit[] = [];
  private turn = 0;

  classifyFile(filePath: string): 'source' | 'test' | 'other' {
    if (FIXTURE_PATTERNS.some(p => p.test(filePath))) return 'other';
    if (TEST_PATTERNS.some(p => p.test(filePath))) return 'test';
    return 'source';
  }

  recordEdit(filePath: string): void {
    const category = this.classifyFile(filePath);
    const entry: FileEdit = { file: filePath, turn: this.turn };
    if (category === 'test') {
      this.testEdits.push(entry);
    } else if (category === 'source') {
      this.sourceEdits.push(entry);
    }
  }

  nextTurn(): void {
    this.turn++;
  }

  /**
   * Set the current turn explicitly. Used by the cross-process turn model:
   * hooks rebuild a fresh FileTracker per invocation and replay turn-stamped
   * edits from the session cache, so the turn cannot be derived by counting
   * nextTurn() calls within one process.
   */
  setTurn(turn: number): void {
    this.turn = turn;
  }

  getTurn(): number {
    return this.turn;
  }

  getSourceEdits(): FileEdit[] {
    return [...this.sourceEdits];
  }

  getTestEdits(): FileEdit[] {
    return [...this.testEdits];
  }

  /**
   * Return source files that were edited without a corresponding test file edit.
   * A source file is "covered" if a test file exists with a matching name component.
   */
  getStaleSources(gracePeriod: number = 0): FileEdit[] {
    const currentTurn = this.turn;
    const testBaseNames = new Set(
      this.testEdits.map(e => extractBaseName(e.file)),
    );

    return this.sourceEdits.filter(edit => {
      // A source edit is exempt during the turn it was made (user hasn't had
      // a chance to write the test yet). gracePeriod adds extra turns of
      // immunity after the edit turn. gracePeriod=0 means stale on the next
      // turn; gracePeriod=1 means stale after 1 additional turn, etc.
      if (currentTurn - edit.turn <= gracePeriod) return false;

      const baseName = extractBaseName(edit.file);
      // Check if any test edit covers this source file
      return !testBaseNames.has(baseName);
    });
  }

  reset(): void {
    this.sourceEdits = [];
    this.testEdits = [];
    this.turn = 0;
  }
}

/**
 * Extract the meaningful base name from a file path for matching.
 * src/router/resolver.ts → resolver
 * tests/router/resolver.test.ts → resolver
 */
function extractBaseName(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? '';
  // Remove all extensions and test markers
  return fileName.replace(/\.test$/, '').replace(/\.spec$/, '').replace(/\.[tj]sx?$/, '').replace(/\.py$/, '').replace(/\.test$/, '');
}

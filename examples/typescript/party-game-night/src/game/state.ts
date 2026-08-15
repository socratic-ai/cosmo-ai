/**
 * Canonical game state, owned by the page. The MC's tools mutate it, the
 * board iframe renders it, and the PreToolUse guard reads it — one source
 * of truth, so a flip the board would not accept is denied before it runs.
 */

export type FeudAnswer = { text: string; points: number; revealed: boolean };

export type Stage =
  | { kind: 'title'; title: string; subtitle: string | null }
  | { kind: 'board'; question: string; answers: FeudAnswer[]; strikes: number }
  | {
      kind: 'quiz';
      question: string;
      /** Which game this quiz moment belongs to — the board shows it, so a
       *  Feud face-off doesn't read as buzzer trivia. */
      label: string | null;
      buzzed: string | null;
    }
  | { kind: 'prompt'; word: string; actor: string; seconds: number }
  | { kind: 'scoreboard' };

export type Team = { name: string; score: number };

export type GameState = { stage: Stage | null; teams: Team[] };

export const MAX_STRIKES = 3;

export class GameStore {
  private state: GameState = { stage: null, teams: [] };
  private listeners = new Set<() => void>();

  getState(): GameState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The current board stage, or null when something else is showing. */
  board(): Extract<Stage, { kind: 'board' }> | null {
    return this.state.stage?.kind === 'board' ? this.state.stage : null;
  }

  showTitle(title: string, subtitle: string | null): void {
    this.set({ ...this.state, stage: { kind: 'title', title, subtitle } });
  }

  /** A new board is a new round: every answer face-down, no strikes. */
  showBoard(question: string, answers: { text: string; points: number }[]): void {
    this.set({
      ...this.state,
      stage: {
        kind: 'board',
        question,
        answers: answers.map((a) => ({ ...a, revealed: false })),
        strikes: 0,
      },
    });
  }

  showScoreboard(): void {
    this.set({ ...this.state, stage: { kind: 'scoreboard' } });
  }

  showQuiz(question: string, label: string | null = null): void {
    this.set({ ...this.state, stage: { kind: 'quiz', question, label, buzzed: null } });
  }

  /** Lock the buzzer to a team. Returns the team, or null when there is no
   *  open quiz question (wrong stage, or someone already buzzed). */
  setBuzzed(teamName: string): string | null {
    const stage = this.state.stage;
    if (stage?.kind !== 'quiz' || stage.buzzed !== null) return null;
    this.set({ ...this.state, stage: { ...stage, buzzed: teamName } });
    return teamName;
  }

  /** Reopen the buzzer on the current quiz question (after a wrong answer
   *  or a steal). Returns false when nothing is locked. */
  clearBuzzer(): boolean {
    const stage = this.state.stage;
    if (stage?.kind !== 'quiz' || stage.buzzed === null) return false;
    this.set({ ...this.state, stage: { ...stage, buzzed: null } });
    return true;
  }

  showPrompt(word: string, actor: string, seconds: number): void {
    this.set({ ...this.state, stage: { kind: 'prompt', word, actor, seconds } });
  }

  /** Flip one answer (zero-based). Returns the flipped answer, or null if
   *  there is no board, the index is out of range, or it is already open. */
  revealAnswer(index: number): FeudAnswer | null {
    const board = this.board();
    const answer = board?.answers[index];
    if (!board || !answer || answer.revealed) return null;
    const answers = board.answers.map((a, i) => (i === index ? { ...a, revealed: true } : a));
    this.set({ ...this.state, stage: { ...board, answers } });
    return { ...answer, revealed: true };
  }

  /** Add a strike. Returns the new count, or null when there is no board
   *  or the round is already struck out. */
  addStrike(): number | null {
    const board = this.board();
    if (!board || board.strikes >= MAX_STRIKES) return null;
    const strikes = board.strikes + 1;
    this.set({ ...this.state, stage: { ...board, strikes } });
    return strikes;
  }

  setTeams(names: string[]): Team[] {
    const teams = names.map((name) => ({ name, score: 0 }));
    this.set({ ...this.state, teams });
    return teams;
  }

  /** Add points to a team by name (case-insensitive). Returns the updated
   *  team, or null if no team matches. */
  awardPoints(teamName: string, points: number): Team | null {
    const wanted = teamName.trim().toLowerCase();
    const index = this.state.teams.findIndex((t) => t.name.toLowerCase() === wanted);
    if (index === -1) return null;
    const teams = this.state.teams.map((t, i) =>
      i === index ? { ...t, score: t.score + points } : t,
    );
    this.set({ ...this.state, teams });
    return teams[index];
  }

  private set(next: GameState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

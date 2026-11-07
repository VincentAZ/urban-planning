import { pointInStudyArea, type Place, type Position } from "@urban/core";
import type {
  EngagementConfig,
  EngagementQuestion,
  EngagementSubmission,
} from "../../../../../packages/core/src/engagement";

export const defaultEngagement = (): EngagementConfig => ({
  introduction: "",
  comments: true,
  votes: true,
  pins: true,
  questions: [],
});
export const disabledEngagement = (): EngagementConfig => ({
  introduction: "",
  comments: false,
  votes: false,
  pins: false,
  questions: [],
});
export function cleanEngagement(value: EngagementConfig): EngagementConfig {
  return {
    ...value,
    introduction: value.introduction.trim(),
    questions: value.questions.map((q) => ({
      ...q,
      prompt: q.prompt.trim(),
      ...(q.type === "single-choice"
        ? { options: q.options?.map((o) => o.trim()) }
        : { options: undefined }),
    })),
  };
}
export function validateEngagement(value: EngagementConfig): string | null {
  if (value.introduction.length > 4000)
    return "Keep the introduction under 4,000 characters.";
  if (value.questions.length > 5) return "Use at most five survey questions.";
  for (const [i, q] of value.questions.entries()) {
    if (!q.prompt.trim() || q.prompt.length > 500)
      return `Add a question ${i + 1} prompt of 1–500 characters.`;
    if (q.type === "single-choice") {
      const choices = q.options?.map((o) => o.trim()) ?? [];
      if (
        choices.length < 2 ||
        choices.length > 8 ||
        choices.some((o) => !o || o.length > 200)
      )
        return `Question ${i + 1} needs 2–8 choices, each 1–200 characters.`;
      if (new Set(choices).size !== choices.length)
        return `Question ${i + 1} has duplicate choices.`;
    }
  }
  return null;
}
export function answerFor(
  answers: Record<string, unknown>,
  id: string,
): string {
  return Object.hasOwn(answers, id) && typeof answers[id] === "string"
    ? (answers[id] as string)
    : "";
}
export function validateSurvey(
  questions: EngagementQuestion[],
  answers: Record<string, string>,
): string | null {
  for (const q of questions) {
    const answer = answerFor(answers, q.id).trim();
    if (q.required && !answer) return `Please answer: ${q.prompt}`;
    if (answer && q.type === "single-choice" && !q.options?.includes(answer))
      return `Choose a listed answer for: ${q.prompt}`;
    if (q.type === "text" && answer.length > 2000)
      return `Keep this answer under 2,000 characters: ${q.prompt}`;
  }
  return null;
}
export function parsePublicPin(
  value: string | null,
  place: Place,
): Position | null {
  if (!value) return null;
  const coordinates = value.split(",");
  if (coordinates.length !== 2 || coordinates.some((v) => !v.trim()))
    return null;
  const position = coordinates.map(Number) as Position;
  return position.every(Number.isFinite) && pointInStudyArea(position, place)
    ? position
    : null;
}
export type SubmissionDraft = EngagementSubmission extends infer T
  ? T extends EngagementSubmission
    ? Omit<T, "idempotencyKey">
    : never
  : never;
/** A lost response can retry the exact request without appending another comment. */
export class SubmissionAttempts {
  private pending = new Map<
    string,
    { signature: string; body: EngagementSubmission }
  >();
  for(draft: SubmissionDraft): EngagementSubmission {
    // The collection may close and reopen while a committed response is lost.
    // Retry its original version and key until the server confirms success or rejection.
    const { expectedCollectionVersion: _version, ...content } = draft;
    const signature = JSON.stringify(content),
      previous = this.pending.get(draft.kind);
    if (previous?.signature === signature) return previous.body;
    const body = {
      ...draft,
      idempotencyKey: crypto.randomUUID(),
    } as EngagementSubmission;
    this.pending.set(draft.kind, { signature, body });
    return body;
  }
  complete(kind: EngagementSubmission["kind"]) {
    this.pending.delete(kind);
  }
  reject(kind: EngagementSubmission["kind"]) {
    this.pending.delete(kind);
  }
  clear() {
    this.pending.clear();
  }
}

import {
  MessageSquare,
  MapPin,
  ThumbsUp,
  ListPlus,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  EngagementConfig,
  EngagementQuestion,
} from "../../../../../packages/core/src/engagement";
import "./engagement-public.css";

export function PublishEngagementConfig({
  value,
  onChange,
  disabled = false,
}: {
  value: EngagementConfig;
  onChange: (value: EngagementConfig) => void;
  disabled?: boolean;
}) {
  const updateQuestion = (id: string, patch: Partial<EngagementQuestion>) =>
    onChange({
      ...value,
      questions: value.questions.map((q) =>
        q.id === id ? { ...q, ...patch } : q,
      ),
    });
  return (
    <fieldset className="engagement-config" disabled={disabled}>
      <legend>Invite useful feedback</legend>
      <p className="muted small">
        Choose what this published link collects. The introduction and questions
        stay frozen with this snapshot; you can close collection later.
      </p>
      <div className="engagement-methods">
        {(
          [
            ["comments", "Written comments", MessageSquare],
            ["votes", "Support / concern responses", ThumbsUp],
            ["pins", "Comments with map locations", MapPin],
          ] as const
        ).map(([key, label, Icon]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={value[key]}
              onChange={(event) =>
                onChange({ ...value, [key]: event.target.checked })
              }
            />
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <label className="field">
        <span>Feedback introduction</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={value.introduction}
          onChange={(event) =>
            onChange({ ...value, introduction: event.target.value })
          }
          placeholder="What would you like people to consider?"
        />
      </label>
      <div className="engagement-survey-heading">
        <strong>
          <ListPlus size={17} /> Short survey
        </strong>
        <span>{value.questions.length} / 5 questions</span>
      </div>
      {value.questions.length === 0 && (
        <p className="muted small">
          Optional. Add a focused question or two to learn what matters locally.
        </p>
      )}
      {value.questions.map((question, index) => (
        <section
          key={question.id}
          className="engagement-question-editor"
          aria-label={`Survey question ${index + 1}`}
        >
          <div className="engagement-question-top">
            <strong>Question {index + 1}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove question ${index + 1}`}
              onClick={() =>
                onChange({
                  ...value,
                  questions: value.questions.filter(
                    (q) => q.id !== question.id,
                  ),
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
          <label className="field">
            <span>Question {index + 1} prompt</span>
            <input
              maxLength={500}
              value={question.prompt}
              onChange={(event) =>
                updateQuestion(question.id, { prompt: event.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Question {index + 1} type</span>
            <select
              value={question.type}
              onChange={(event) =>
                updateQuestion(question.id, {
                  type: event.target.value as EngagementQuestion["type"],
                  options:
                    event.target.value === "single-choice"
                      ? ["", ""]
                      : undefined,
                })
              }
            >
              <option value="text">Written answer</option>
              <option value="single-choice">Choose one option</option>
            </select>
          </label>
          <label className="engagement-check">
            <input
              type="checkbox"
              checked={question.required}
              onChange={(event) =>
                updateQuestion(question.id, { required: event.target.checked })
              }
            />{" "}
            Required question {index + 1}
          </label>
          {question.type === "single-choice" && (
            <div className="engagement-options-editor">
              {question.options?.map((option, choice) => (
                <div key={choice}>
                  <label className="field">
                    <span>
                      Question {index + 1}, choice {choice + 1}
                    </span>
                    <input
                      maxLength={200}
                      value={option}
                      onChange={(event) =>
                        updateQuestion(question.id, {
                          options: question.options!.map((v, i) =>
                            i === choice ? event.target.value : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove question ${index + 1} choice ${choice + 1}`}
                    disabled={question.options!.length <= 2}
                    onClick={() =>
                      updateQuestion(question.id, {
                        options: question.options!.filter(
                          (_, i) => i !== choice,
                        ),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button compact"
                disabled={(question.options?.length ?? 0) >= 8}
                onClick={() =>
                  updateQuestion(question.id, {
                    options: [...question.options!, ""],
                  })
                }
              >
                <Plus size={14} /> Add choice to question {index + 1}
              </button>
            </div>
          )}
        </section>
      ))}
      <button
        type="button"
        className="button compact"
        disabled={value.questions.length >= 5}
        onClick={() =>
          onChange({
            ...value,
            questions: [
              ...value.questions,
              {
                id: `q_${crypto.randomUUID()}`,
                prompt: "",
                type: "text",
                required: false,
              },
            ],
          })
        }
      >
        <Plus size={15} /> Add survey question
      </button>
      <p className="muted small">
        All participation is free. Responses go to the project team and are kept
        out of the public map.
      </p>
    </fieldset>
  );
}

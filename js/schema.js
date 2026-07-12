// schema.js — a document is an ordered set of fields.
//
// This is the intake equivalent of amino's Amino.schema.json: each field has a
// stable `path` (used as the DEF path), a human `label`, a `type` for
// validation, an optional `prompt` (how the assistant opens the question),
// `help` (shown when the person is stuck), and optional `enum`.
//
// Swap this object out to fill a different document. The controller reads it
// generically — nothing below is hard-coded anywhere else.

export const SCHEMA = {
  id: "i589-lite",
  title: "Asylum intake (I-589, short form)",
  blurb: "We'll go through this one question at a time. Nothing is saved until you confirm it, and you can stop and come back — your place is held.",
  fields: [
    {
      path: "full_legal_name",
      label: "Full legal name",
      type: "text",
      required: true,
      prompt: "Let's start simple. What's your full legal name, exactly as it appears on your documents?",
      help: "Write it the way it's printed on your passport or ID — first, middle, and last. If your documents disagree with each other, give me the passport version and we'll note the difference later.",
    },
    {
      path: "other_names",
      label: "Other names used",
      type: "text",
      required: false,
      prompt: "Have you ever used any other names — maiden name, nickname on official papers, a different spelling?",
      help: "This includes maiden names, names from a previous marriage, or spellings used on older documents. If none, just say \"none.\"",
    },
    {
      path: "date_of_birth",
      label: "Date of birth",
      type: "date",
      required: true,
      prompt: "What's your date of birth?",
      help: "Any clear format is fine — I'll standardize it. If you only know the year, tell me that and we'll flag it.",
    },
    {
      path: "country_of_birth",
      label: "Country of birth",
      type: "text",
      required: true,
      prompt: "Which country were you born in?",
      help: "Use the country's current name. If the borders or the name have changed since you were born, tell me both and I'll record it.",
    },
    {
      path: "nationality",
      label: "Nationality",
      type: "text",
      required: true,
      prompt: "What's your nationality or citizenship?",
      help: "This is the country whose passport you hold. If you're stateless, or hold more than one, say so — that matters for this form.",
    },
    {
      path: "entry_date",
      label: "Date of last U.S. entry",
      type: "date",
      required: true,
      prompt: "When did you most recently enter the United States?",
      help: "Your best honest estimate is okay if you're unsure of the exact day. Approximate dates get flagged, not rejected.",
    },
    {
      path: "fear_basis",
      label: "Basis of fear",
      type: "enum",
      enum: ["Race", "Religion", "Nationality", "Political opinion", "Social group"],
      required: true,
      prompt: "Asylum is based on a fear of harm for one of five reasons. Which comes closest to your situation?",
      help: "The five protected grounds are race, religion, nationality, political opinion, and membership in a particular social group. Many cases touch more than one — pick the closest and we can add detail after. There's no wrong instinct here.",
    },
    {
      path: "narrative",
      label: "What happened",
      type: "text",
      required: true,
      prompt: "In your own words, and only as much as you're ready to share right now: what happened that made you afraid to stay?",
      help: "You don't have to write it all at once or in order. A few sentences is a fine start — we can come back and add to it. Take breaks whenever you need.",
    },
  ],
};

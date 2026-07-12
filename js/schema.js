// schema.js — a document is an ordered set of fields.
//
// This is the intake equivalent of amino's Amino.schema.json: each field has a
// stable `path` (used as the DEF path), a human `label`, a `type` for
// validation, an optional `prompt` (how the assistant opens the question),
// `help` (shown when the person is stuck), optional `enum`, and optional `tags`
// (used by knowledge.js to fold in the right reference notes).
//
// This particular document — a telecom customer-service complaint — is only a
// SAMPLE. It is not the end use case; it's here to exercise the engine. Swap
// this object out to fill a different document and nothing else changes: the
// controller, the fold, the store and the account layer all read it generically.

export const SCHEMA = {
  id: "telecom-complaint",
  title: "Customer service complaint",
  blurb: "Tell us what happened, in your own words — we'll log every answer to your case one question at a time. Nothing is saved until you confirm it, and you can stop and come back; your place is held.",
  fields: [
    {
      path: "account_id",
      label: "Account or phone number",
      type: "text",
      required: true,
      tags: ["identity"],
      prompt: "Let's start with the account this is about. What's your account number or the phone number on it?",
      help: "It's usually on your bill or in your online account. The last few digits are enough to identify it — you don't need to share the full number if you'd rather not.",
    },
    {
      path: "service",
      label: "Service affected",
      type: "enum",
      enum: ["Mobile", "Broadband", "Landline", "TV"],
      required: true,
      tags: ["service"],
      prompt: "Which service is this about?",
      help: "Pick the one most affected. If it's a bundle and more than one is involved, choose the main one and we can note the rest in the description.",
    },
    {
      path: "issue_type",
      label: "Type of issue",
      type: "enum",
      enum: ["Billing", "Poor customer service", "Service outage", "Contract or cancellation", "Other"],
      required: true,
      tags: ["triage"],
      prompt: "Broadly, what kind of issue is it?",
      help: "This just routes your complaint to the right team. If it's more than one — say a billing error made worse by poor service — pick the one that matters most to you.",
    },
    {
      path: "started",
      label: "When it started",
      type: "text",
      required: true,
      tags: ["dates"],
      prompt: "When did this start?",
      help: "An approximate answer is fine — \"early June\" or \"about three weeks ago\" both work. If there was a specific date things went wrong, even better.",
    },
    {
      path: "prior_contact",
      label: "Previous contact",
      type: "text",
      required: true,
      tags: ["procedure"],
      prompt: "Have you contacted us about this already? If so, roughly how many times, and do you have any reference numbers?",
      help: "Calls, chats, emails — all count. If you weren't given a reference or it wasn't resolved, just say so; that's part of the record.",
    },
    {
      path: "description",
      label: "What happened",
      type: "text",
      required: true,
      tags: ["core"],
      prompt: "Now the important part — tell me what happened, in your own words. Take as much space as you need; I'll log it exactly as you say it.",
      help: "You don't have to be formal or complete in one go. A few sentences is a fine start, and we can add to it. Times, amounts, and what was said all help, but only include what you're comfortable putting on the record.",
    },
    {
      path: "impact",
      label: "How it's affected you",
      type: "text",
      required: false,
      tags: ["impact"],
      prompt: "Has this affected you beyond the service itself? Time lost, missed calls for work, money out of pocket — anything you'd want on the record. You can skip this.",
      help: "This is optional, but it often matters for how a complaint is weighed. Concrete effects — hours on hold, a missed appointment, extra costs — are worth noting.",
    },
    {
      path: "resolution",
      label: "What outcome you want",
      type: "text",
      required: true,
      tags: ["resolution"],
      prompt: "Last one: what would put this right for you?",
      help: "A refund, a correction to your bill, an apology, the service actually fixed — whatever a good outcome looks like to you. Being specific here helps the agent respond to the right thing.",
    },
  ],
};

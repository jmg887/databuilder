// Setup checklist rail (mockup: left column). Purely presentational — the
// current step is DERIVED and passed in; steps before it are "done", the
// current one is "active", later ones are "locked" (visually inert).

const STEPS = [
  {
    n: 1,
    title: 'Create your site',
    body: "Give your business a name so we know what we're tracking.",
  },
  {
    n: 2,
    title: 'Install the tracking script',
    body: 'One snippet, pasted once. It quietly watches where your visitors come from.',
  },
  {
    n: 3,
    title: 'Connect Stripe',
    body: "We'll match your visitors to your actual payments — so you see which channel made you money.",
  },
];

// `currentStep` is 1, 2, or 3.
export default function ChecklistRail({ currentStep }) {
  return (
    <div className="rail">
      <div className="rail-title">Setup checklist</div>
      {STEPS.map((s) => {
        let stateClass = 'locked';
        if (s.n < currentStep) stateClass = 'done';
        else if (s.n === currentStep) stateClass = 'active';
        return (
          <div key={s.n} className={`rail-item ${stateClass}`}>
            <div className="rail-dot">{s.n < currentStep ? '✓' : s.n}</div>
            <div className="rail-text">
              <h4>{s.title}</h4>
              <p>{s.body}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

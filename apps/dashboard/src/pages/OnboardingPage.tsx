import { useState } from "react";

import { REPO_API_ENDPOINTS } from "../api/repoTelemetry";
import { repoStore } from "../store/repos";
import { makeRepo, PROOF_POLICIES, REPO_TASK_TYPES, type ProofPolicy, type RepoTaskType } from "../types/repo";
import { navigate } from "./navigation";

const STEPS = ["OAuth", "Select repo", "Task types", "Proof policy", "Test run", "Confirm"] as const;

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [githubConnected, setGithubConnected] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [selected, setSelected] = useState(false);
  const [taskTypes, setTaskTypes] = useState<readonly RepoTaskType[]>(["bugs"]);
  const [proofPolicy, setProofPolicy] = useState<ProofPolicy>("balanced");
  const [testRunComplete, setTestRunComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const advance = () => {
    setError(null);
    if (step === 0 && !githubConnected) return setError("Connect GitHub before selecting repositories.");
    if (step === 1) {
      try {
        const url = new URL(repoUrl);
        if (url.protocol !== "https:") throw new Error("Repository URL must use https.");
      } catch {
        return setError("Enter an https repository URL.");
      }
      if (repoName.trim() === "" || !selected) return setError("Select one repository to continue.");
    }
    if (step === 2 && taskTypes.length === 0) return setError("Choose at least one task type.");
    if (step === 4 && !testRunComplete) return setError("Run the dry-run task before going live.");
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  };

  const finish = () => {
    const id = repoName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "connected-repo";
    const repo = makeRepo({
      id,
      reponame: repoName.trim(),
      repourl: repoUrl.trim(),
      active: true,
      task_types: taskTypes,
      settings: { proofpolicy: proofPolicy, workerpoolsize: 2, alertthreshold: 0.1 },
    });
    repoStore.list([...repoStore.getState().repos.filter((candidate) => candidate.id !== repo.id), repo]);
    repoStore.select(repo.id);
    navigate(`/repos/${repo.id}`);
  };

  return (
    <div className="repo-page onboarding-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Setup</p>
          <h1>Connect a repository</h1>
          <p className="muted">The six-step flow is wired locally; OAuth, GitHub repo discovery, dry-run execution, and persistence remain API placeholders.</p>
        </div>
      </div>
      <ol className="wizard-steps" aria-label="Onboarding progress">
        {STEPS.map((label, index) => <li className={index === step ? "wizard-step wizard-step--current" : "wizard-step"} key={label}>{index + 1}. {label}</li>)}
      </ol>
      <section className="wizard-panel" aria-labelledby="wizard-heading">
        <h2 id="wizard-heading">Step {step + 1}: {STEPS[step]}</h2>
        {error === null ? null : <p className="error-text" role="alert">{error}</p>}
        {step === 0 ? (
          <div className="wizard-copy">
            <p>Authorize the GitHub integration so Remudero can list repositories and read the selected repo’s task configuration.</p>
            <button type="button" onClick={() => setGithubConnected(true)}>{githubConnected ? "GitHub connected" : "Connect GitHub (placeholder)"}</button>
            <p className="source-note">OAuth endpoint placeholder: <code>{REPO_API_ENDPOINTS.githubOAuth}</code></p>
          </div>
        ) : null}
        {step === 1 ? (
          <div className="wizard-form">
            <label>Repository name<input value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="org/repository" /></label>
            <label>Repository URL<input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/repository" /></label>
            <label className="check-row"><input type="checkbox" checked={selected} onChange={(event) => setSelected(event.target.checked)} /> Select this repository to activate</label>
            <p className="source-note">GitHub repository list placeholder: <code>{REPO_API_ENDPOINTS.repos}</code></p>
          </div>
        ) : null}
        {step === 2 ? (
          <fieldset className="choice-grid"><legend>Task types</legend>{REPO_TASK_TYPES.map((type) => <label className="check-row" key={type}><input type="checkbox" checked={taskTypes.includes(type)} onChange={(event) => setTaskTypes((current) => event.target.checked ? [...current, type] : current.filter((item) => item !== type))} /> {type}</label>)}</fieldset>
        ) : null}
        {step === 3 ? (
          <fieldset className="choice-grid"><legend>Proof policy</legend>{PROOF_POLICIES.map((policy) => <label className="policy-choice" key={policy}><input type="radio" name="proof-policy" value={policy} checked={proofPolicy === policy} onChange={() => setProofPolicy(policy)} /><span><strong>{policy}</strong><small>{policy === "strict" ? "All work must meet executable proof gates." : policy === "balanced" ? "Use standard gates with operator review for ambiguity." : "Move quickly with lighter evidence requirements."}</small></span></label>)}</fieldset>
        ) : null}
        {step === 4 ? (
          <div className="dry-run-panel"><p>Dry-run one task against the selected configuration. No daemon call is made by this scaffold.</p><button type="button" onClick={() => setTestRunComplete(true)}>{testRunComplete ? "Dry-run complete" : "Run dry-run (placeholder)"}</button>{testRunComplete ? <pre className="dry-run-output">{`DRY RUN\nrepo: ${repoName}\nproof policy: ${proofPolicy}\nresult: placeholder — execution API pending`}</pre> : null}</div>
        ) : null}
        {step === 5 ? <div className="wizard-copy"><p>Review the selected repository, task types, and proof policy. Confirming activates a local scaffold record; server persistence is not wired.</p><dl className="metric-list"><div><dt>Repository</dt><dd>{repoName || "—"}</dd></div><div><dt>Task types</dt><dd>{taskTypes.join(", ") || "—"}</dd></div><div><dt>Proof policy</dt><dd>{proofPolicy}</dd></div></dl></div> : null}
        <div className="wizard-actions">
          {step > 0 ? <button type="button" onClick={() => { setError(null); setStep((current) => current - 1); }}>Back</button> : null}
          {step < STEPS.length - 1 ? <button type="button" onClick={advance}>Continue</button> : <button type="button" onClick={finish}>Confirm and go live</button>}
        </div>
      </section>
    </div>
  );
}

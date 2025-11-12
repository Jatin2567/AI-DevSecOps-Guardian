// frontend/src/components/FailureCard.jsx
import React from 'react';

export default function FailureCard({ failure }) {
  return (
    <div className="card">
      <h3>{failure.jobName} — {failure.pipelineId}</h3>
      <p><strong>Root cause:</strong> {failure.analysis?.root_cause}</p>
      <p><strong>Suggested fix:</strong> {failure.analysis?.suggested_fix}</p>
      <a href={failure.issueWebUrl} target="_blank" rel="noreferrer">Open Issue</a>
    </div>
  );
}

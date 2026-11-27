section: Fixes

- **A run that recovery ends no longer leaves its spend request in the owner's inbox (#288).** A controller that crashed after writing a spend file and before blocking could be restarted with no recovery attempts left; the run then ended EXHAUSTED through recovery, which did not remove the file, so `stack-inbox` kept offering an `orbit decide ... approve` for a run that was over. Both recovery paths that end a run now remove its spend files.

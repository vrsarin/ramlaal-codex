const requiredSteps = ['user', 'core_config', 'analytics', 'integration']

export function storedOnboardingComplete(done) {
  if (!Array.isArray(done) || done.some((step) => typeof step !== 'string') || new Set(done).size !== done.length) {
    throw new Error('Home Assistant returned invalid stored onboarding state')
  }
  return requiredSteps.every((step) => done.includes(step))
}

export function onboardingComplete(steps) {
  if (!Array.isArray(steps) || steps.some((step) => typeof step?.step !== 'string' || typeof step.done !== 'boolean')) {
    throw new Error('Home Assistant returned invalid onboarding state')
  }
  for (const required of requiredSteps) {
    if (steps.filter((step) => step.step === required).length !== 1) throw new Error(`Home Assistant onboarding step ${required} is missing or duplicated`)
  }
  return steps.every((step) => step.done)
}

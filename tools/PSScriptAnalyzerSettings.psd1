@{
  Severity = @(
    'Error',
    'Warning'
  )
  ExcludeRules = @(
    'PSAvoidUsingWriteHost',
    'PSUseShouldProcessForStateChangingFunctions',
    # The script-level parameters are used inside the functions, which this rule
    # does not follow. Suppressing it in the script via an attribute is not an
    # option: target PCs run it in ConstrainedLanguage mode.
    'PSReviewUnusedParameter',
    # Update-AllTools updates several tools at once; the plural is intentional.
    'PSUseSingularNouns'
  )
}

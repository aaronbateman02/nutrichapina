$ErrorActionPreference = 'Stop'
$base = 'https://staging.nutrichapina.com'
$pass = 'Verify-pass-123'
$results = @()
function Check($name, $cond) {
  $script:results += [pscustomobject]@{ Step = $name; Result = if ($cond) { 'PASS' } else { 'FAIL' } }
  if (-not $cond) { Write-Host "FAIL: $name" -ForegroundColor Red }
  else { Write-Host "PASS: $name" }
}
function Post($sess, $path, $body) {
  Invoke-RestMethod -Uri "$base$path" -Method Post -ContentType 'application/json' `
    -Body ($body | ConvertTo-Json -Depth 8) -WebSession $sess
}
function GetP($sess, $path) {
  Invoke-RestMethod -Uri "$base$path" -Method Get -WebSession $sess
}

# 1. register 3 fictional accounts
$diet = 'm2.verify.dietitian@example.test'
$custA = 'm2.verify.custA@example.test'
$custB = 'm2.verify.custB@example.test'
foreach ($e in @($diet, $custA, $custB)) {
  try {
    Invoke-RestMethod -Uri "$base/api/v1/auth/register" -Method Post -ContentType 'application/json' `
      -Body (@{ email = $e; password = $pass; locale = 'en' } | ConvertTo-Json) | Out-Null
    Check "register $e" $true
  } catch {
    $code = 0
    try { $code = $_.Exception.Response.StatusCode.Value__ } catch {}
    Check "register $e (best-effort; SQL seed is authoritative)" ($code -eq 409 -or $code -eq 429 -or $code -eq 0)
  }
}

# 2. verify + promote via SQL (staging only, fictional accounts; no parens for remote bash)
$seedSql = "UPDATE users SET email_verified_at=now() WHERE email='$diet'; " +
"UPDATE users SET email_verified_at=now() WHERE email='$custA'; " +
"UPDATE users SET email_verified_at=now() WHERE email='$custB'; " +
"INSERT INTO user_roles(user_id,role) SELECT id,'dietitian' FROM users WHERE email='$diet' ON CONFLICT DO NOTHING; " +
"UPDATE client_profiles SET primary_professional_id=(SELECT id FROM users WHERE email='$diet') WHERE user_id=(SELECT id FROM users WHERE email='$custA');"
$seedSql | ssh ec2-user@77.112.201.29 "docker run --rm -i --network nutrichapina-staging-net -e PGPASSWORD=b3ce115e5be931fe960161d1b504580c9e7d86d75828ada6 postgres:16 psql -h nutrichapina-postgres -U nutri -d nutrichapina -v ON_ERROR_STOP=1"
Check 'sql verify+promote' ($LASTEXITCODE -eq 0)

# 3. logins
$d = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$a = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$b = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Post $d '/api/v1/auth/login' @{ email = $diet; password = $pass } | Out-Null
Post $a '/api/v1/auth/login' @{ email = $custA; password = $pass } | Out-Null
Post $b '/api/v1/auth/login' @{ email = $custB; password = $pass } | Out-Null
$meD = GetP $d '/api/v1/me'
Check 'dietitian roles' ($meD.data.roles -contains 'dietitian')

# 4. ingredients
$i1 = Post $d '/api/v1/staff/ingredients' @{ canonical_name = 'M2 Verify Chicken'; category = 'protein'; translations = @{ en = 'M2 Verify Chicken'; es = 'Pollo Verificacion M2' }; conversions = @(@{ from_unit = 'kg'; to_unit = 'g'; factor = 1000 }) }
$i2 = Post $d '/api/v1/staff/ingredients' @{ canonical_name = 'M2 Verify Rice'; category = 'grains'; translations = @{ en = 'M2 Verify Rice'; es = 'Arroz Verificacion M2' } }
Check 'ingredients 201' ($i1.data.id -and $i2.data.id)

# 5. recipe lifecycle
$rc = Post $d '/api/v1/staff/recipes' @{
  slug = 'm2-verify-bowl'; title_en = 'M2 Verify Bowl'; title_es = 'Tazon Verificacion M2';
  description_en = 'd'; description_es = 'd'; steps_en = @('Cook.'); steps_es = @('Cocinar.');
  servings = 4; items = @(@{ ingredient_id = $i1.data.id; quantity = 500; unit = 'g' }, @{ ingredient_id = $i2.data.id; quantity = 200; unit = 'g' })
}
$rev = $rc.data.revision_id; $recipeId = $rc.data.id
Check 'recipe draft 201' ($rev -ne $null)
$v = Post $d "/api/v1/staff/recipes/revisions/$rev/validate" @{}
Check 'validate clean' ($v.data.valid -eq $true)
$p1 = GetP $d "/api/v1/staff/recipes/revisions/$rev/preview?locale=en&servings=1"
Check 'preview 125g' ($p1.data.items[0].scaled_quantity -eq 125)
Post $d "/api/v1/staff/recipes/revisions/$rev/submit" @{} | Out-Null
$ap = Post $d "/api/v1/staff/recipes/revisions/$rev/approve" @{ allergens_reviewed = $true }
Check 'approve 200' ($ap.data.ok -eq $true)
$pb = Post $d "/api/v1/staff/recipes/revisions/$rev/publish" @{}
Check 'publish 200' ($pb.data.ok -eq $true)

# 6. program: 7-day x breakfast/lunch/dinner
$pr = Post $d '/api/v1/staff/programs' @{ name = 'M2 Verify 7-day' }
$vid = $pr.data.version_id
$slots = @()
foreach ($day in 1..7) { foreach ($s in @('breakfast','lunch','dinner')) {
  $slots += @{ day = $day; slot = $s; recipe_revision_id = $rev; servings = 1 }
} }
$put = Invoke-RestMethod -Uri "$base/api/v1/staff/programs/versions/$vid/slots" -Method Put `
  -ContentType 'application/json' -Body (@{ slots = $slots } | ConvertTo-Json -Depth 8) -WebSession $d
Check 'slots 21' ($put.data.slots -eq 21)
Post $d "/api/v1/staff/programs/versions/$vid/submit" @{} | Out-Null
Post $d "/api/v1/staff/programs/versions/$vid/approve" @{} | Out-Null
Post $d "/api/v1/staff/programs/versions/$vid/publish" @{} | Out-Null
$meA = GetP $a '/api/v1/me'
$asg = Post $d '/api/v1/staff/plans/assign' @{ client_id = $meA.data.user.id; program_version_id = $vid }
Check 'assign 21 meals' ($asg.data.meals -eq 21)
$planId = $asg.data.plan_id

# 7. customer reads own plan + recipe; nutrition hidden
$plans = GetP $a '/api/v1/me/plans'
Check 'custA 1 plan' ($plans.data.Count -eq 1)
$det = GetP $a "/api/v1/me/plans/$planId"
Check 'custA 21 meals' ($det.data.meals.Count -eq 21)
$rec = GetP $a "/api/v1/me/recipes/$rev"
Check 'nutrition hidden' ($rec.data.nutrition -eq $null -and $rec.data.nutrition_verified -eq $false)

# 8. cross-customer isolation
try { GetP $b "/api/v1/me/plans/$planId" | Out-Null; Check 'custB plan 404' $false }
catch { Check 'custB plan 404' ($_.Exception.Response.StatusCode.Value__ -eq 404) }
try { GetP $b "/api/v1/me/recipes/$rev" | Out-Null; Check 'custB recipe 403' $false }
catch { Check 'custB recipe 403' ($_.Exception.Response.StatusCode.Value__ -eq 403) }

Write-Host ''
$results | Format-Table -AutoSize
$fail = ($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host "FAILED: $fail / $($results.Count)"
exit $fail

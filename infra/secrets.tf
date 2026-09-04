# Secrets Manager for DB credentials and Stripe keys. Values are never
# hardcoded in Terraform or committed to the repo. The DB password is
# generated at apply time; Stripe keys are placeholders to be filled in
# out-of-band (AWS console / CLI) after apply.

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/db-credentials"
  description = "RDS Postgres connection credentials"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.postgres.address
    port     = 5432
    username = var.db_username
    password = random_password.db.result
    dbname   = var.db_name
  })
}

# Stripe secret key placeholder. The actual value must be set manually after
# apply (e.g. `aws secretsmanager put-secret-value`), NOT committed.
resource "aws_secretsmanager_secret" "stripe" {
  name        = "${local.name}/stripe-webhook-secret"
  description = "Stripe webhook signing secret (set manually after apply)"
}

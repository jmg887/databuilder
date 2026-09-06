# Lambda functions + shared layer.
#
# The shared code (backend/shared) is packaged as a Lambda layer mounted at
# /opt/nodejs, which is why lambdas require('/opt/nodejs/index'). Each lambda's
# own code + node_modules is zipped from its build directory.
#
# NOTE: run `make build` (see Makefile) before `terraform apply` so that each
# lambda directory has its node_modules installed and the layer staging dir is
# populated.

# --- Shared layer ----------------------------------------------------------
# Lambda layers expose Node modules at /opt/nodejs, so the shared code must be
# staged under a `nodejs/` directory inside the zip. `make build` copies
# backend/shared into infra/build/layer/nodejs before apply.

data "archive_file" "shared_layer" {
  type        = "zip"
  source_dir  = "${path.module}/build/layer"
  output_path = "${path.module}/build/shared-layer.zip"
}

resource "aws_lambda_layer_version" "shared" {
  layer_name          = "${local.name}-shared"
  filename            = data.archive_file.shared_layer.output_path
  source_code_hash    = data.archive_file.shared_layer.output_base64sha256
  compatible_runtimes = [var.lambda_runtime]
}

# --- Common env for DB-touching lambdas ------------------------------------

locals {
  common_env = {
    DB_SECRET_ARN             = aws_secretsmanager_secret.db.arn
    STRIPE_WEBHOOK_SECRET_ARN = aws_secretsmanager_secret.stripe.arn
  }
}

# --- ingest ----------------------------------------------------------------

data "archive_file" "ingest" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/lambdas/ingest"
  output_path = "${path.module}/build/ingest.zip"
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${local.name}-ingest"
  role             = aws_iam_role.lambda.arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  timeout          = 15
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.common_env
  }
}

# --- stripe-webhook --------------------------------------------------------

data "archive_file" "stripe_webhook" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/lambdas/stripe-webhook"
  output_path = "${path.module}/build/stripe-webhook.zip"
}

resource "aws_lambda_function" "stripe_webhook" {
  function_name    = "${local.name}-stripe-webhook"
  role             = aws_iam_role.lambda.arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.stripe_webhook.output_path
  source_code_hash = data.archive_file.stripe_webhook.output_base64sha256
  timeout          = 15
  memory_size      = 256
  layers           = [aws_lambda_layer_version.shared.arn]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.common_env
  }
}

# --- dashboard-api ---------------------------------------------------------

data "archive_file" "dashboard_api" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/lambdas/dashboard-api"
  output_path = "${path.module}/build/dashboard-api.zip"
}

resource "aws_lambda_function" "dashboard_api" {
  function_name    = "${local.name}-dashboard-api"
  role             = aws_iam_role.lambda.arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.dashboard_api.output_path
  source_code_hash = data.archive_file.dashboard_api.output_base64sha256
  # Longer timeout: the Stripe connect flow runs the historical backfill
  # synchronously (paginating Stripe's Events API) within this request.
  timeout     = 120
  memory_size = 256
  layers      = [aws_lambda_layer_version.shared.arn]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = merge(local.common_env, {
      TRACKING_SCRIPT_URL = "https://${aws_cloudfront_distribution.assets.domain_name}/t.js"
      # Used to build the webhook URL registered on Stripe and to name the
      # per-site secrets (databuilder-prod/site-<id>-stripe-*).
      API_BASE_URL       = aws_apigatewayv2_api.main.api_endpoint
      SITE_SECRET_PREFIX = local.name
    })
  }
}

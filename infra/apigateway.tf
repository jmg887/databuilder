# API Gateway HTTP API with the public, webhook, and authenticated routes.

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    # /collect is a public tracking endpoint by design.
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

# --- Cognito JWT authorizer (for dashboard routes) -------------------------

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name}-cognito"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.dashboard.id]
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# --- Integrations ----------------------------------------------------------

resource "aws_apigatewayv2_integration" "ingest" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingest.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "stripe_webhook" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.stripe_webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "dashboard_api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.dashboard_api.invoke_arn
  payload_format_version = "2.0"
}

# --- Public route: POST /collect (no auth) ---------------------------------

resource "aws_apigatewayv2_route" "collect" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /collect"
  target    = "integrations/${aws_apigatewayv2_integration.ingest.id}"
}

# --- Webhook route: POST /webhooks/stripe (no JWT; verified in-lambda) ------

resource "aws_apigatewayv2_route" "stripe" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /webhooks/stripe"
  target    = "integrations/${aws_apigatewayv2_integration.stripe_webhook.id}"
}

# --- Authenticated dashboard routes (Cognito JWT) --------------------------

locals {
  dashboard_routes = [
    "GET /sites",
    "POST /sites",
    "GET /sites/{id}/overview",
    "GET /sites/{id}/visitors",
    "GET /sites/{id}/integrations",
    "POST /sites/{id}/integrations/stripe",
    "DELETE /sites/{id}/integrations/stripe",
  ]
}

resource "aws_apigatewayv2_route" "dashboard" {
  for_each           = toset(local.dashboard_routes)
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.dashboard_api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# --- Lambda invoke permissions ---------------------------------------------

resource "aws_lambda_permission" "ingest" {
  statement_id  = "AllowAPIGatewayInvokeIngest"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "stripe_webhook" {
  statement_id  = "AllowAPIGatewayInvokeStripe"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.stripe_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "dashboard_api" {
  statement_id  = "AllowAPIGatewayInvokeDashboard"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dashboard_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

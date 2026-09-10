output "api_base_url" {
  description = "Base URL for the HTTP API (use for VITE_API_BASE_URL)"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "collect_url" {
  description = "Public tracking endpoint"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/collect"
}

output "stripe_webhook_url" {
  description = "Stripe webhook URL (append ?site=<siteId> when configuring in Stripe)"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/webhooks/stripe"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.dashboard.id
}

output "assets_bucket" {
  description = "S3 bucket for the dashboard build + tracking script"
  value       = aws_s3_bucket.assets.id
}

output "cloudfront_domain" {
  description = "CloudFront domain serving t.js and the dashboard"
  value       = aws_cloudfront_distribution.assets.domain_name
}

output "landing_bucket" {
  description = "S3 bucket for the marketing landing page (separate from dashboard)"
  value       = aws_s3_bucket.landing.id
}

output "landing_url" {
  description = "Public URL of the marketing landing page (default CloudFront domain)"
  value       = "https://${aws_cloudfront_distribution.landing.domain_name}"
}

output "landing_signup_url" {
  description = "Sign-up URL the landing page's CTAs point to"
  value       = local.landing_signup_url
}

output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "stripe_secret_arn" {
  description = "Set the Stripe webhook signing secret value here after apply"
  value       = aws_secretsmanager_secret.stripe.arn
}

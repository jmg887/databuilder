# Public marketing landing page — hosted SEPARATELY from the dashboard app.
#
# This is a NEW, standalone S3 bucket + CloudFront distribution, deliberately
# independent from the dashboard's `assets` bucket/distribution (see
# cloudfront.tf). It mirrors that same OAC-fronted private-bucket pattern.
#
# The landing page is a single static file (frontend/landing/index.html). Its
# three "Get early access" links point at the existing dashboard sign-up flow.
# Because the dashboard's CloudFront domain is only known at apply time, we
# render index.html here by substituting the __DATABUILDER_SIGNUP_URL__ token,
# then upload the rendered file — no client build step, staying true to the
# plain-HTML approach.

locals {
  # Default sign-up entry point = the dashboard SPA's /login route (which has a
  # "Sign up" toggle). Overridable via var.landing_signup_url.
  landing_signup_url = (
    var.landing_signup_url != "" ?
    var.landing_signup_url :
    "https://${aws_cloudfront_distribution.assets.domain_name}/login"
  )

  landing_index_rendered = replace(
    file("${path.module}/../frontend/landing/index.html"),
    "__DATABUILDER_SIGNUP_URL__",
    local.landing_signup_url
  )
}

# --- S3 bucket (private, OAC-only) -----------------------------------------

resource "aws_s3_bucket" "landing" {
  bucket = "${local.name}-landing-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "landing" {
  bucket                  = aws_s3_bucket.landing.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Upload the rendered landing page. Using content (not a static object key)
# so the sign-up URL is baked in at apply time; the md5 etag triggers a
# re-upload whenever the source HTML or the injected URL changes.
resource "aws_s3_object" "landing_index" {
  bucket        = aws_s3_bucket.landing.id
  key           = "index.html"
  content       = local.landing_index_rendered
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
  etag          = md5(local.landing_index_rendered)
}

# --- CloudFront (separate distribution + OAC) ------------------------------

resource "aws_cloudfront_origin_access_control" "landing" {
  name                              = "${local.name}-landing-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "landing" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${local.name} marketing landing page"

  origin {
    domain_name              = aws_s3_bucket.landing.bucket_regional_domain_name
    origin_id                = "s3-landing"
    origin_access_control_id = aws_cloudfront_origin_access_control.landing.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-landing"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 300
    max_ttl     = 3600
  }

  # Single-page site: serve index.html for any not-found path.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Default CloudFront domain for now — no custom domain decided yet (brief §5).
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Bucket policy: only this landing CloudFront distribution may read objects.
data "aws_iam_policy_document" "landing_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.landing.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.landing.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "landing" {
  bucket = aws_s3_bucket.landing.id
  policy = data.aws_iam_policy_document.landing_bucket.json
}

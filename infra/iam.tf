# IAM role shared by all lambdas. Grants VPC networking, logging, and
# read access to the specific secrets they need.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# VPC access (create/manage ENIs) + CloudWatch logs.
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Read the shared secrets (DB + legacy Stripe placeholder) and read/write the
# per-site Stripe secrets. The per-site wildcard already covered reads for the
# webhook secret; the self-service connect/disconnect flow also needs to
# create, update, and delete the per-site restricted-key and webhook secrets
# (databuilder-prod/site-*-stripe-rak and -stripe-webhook).
data "aws_iam_policy_document" "lambda_secrets" {
  # Read shared app secrets.
  statement {
    sid     = "ReadSharedSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db.arn,
      aws_secretsmanager_secret.stripe.arn,
    ]
  }

  # Read + manage per-site secrets (matches the existing wildcard, per §8).
  statement {
    sid = "ManagePerSiteSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:TagResource",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}/site-*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name   = "${local.name}-lambda-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_secrets.json
}

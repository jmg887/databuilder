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

# Read only the two secrets this app uses.
data "aws_iam_policy_document" "lambda_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db.arn,
      aws_secretsmanager_secret.stripe.arn,
      "arn:aws:secretsmanager:eu-north-1:484673686538:secret:databuilder-prod/site-*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name   = "${local.name}-lambda-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_secrets.json
}

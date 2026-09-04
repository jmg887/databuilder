variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-north-1"
}

variable "project" {
  description = "Project name prefix for resources"
  type        = string
  default     = "databuilder"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "db_name" {
  description = "Postgres database name"
  type        = string
  default     = "analytics"
}

variable "db_username" {
  description = "Postgres master username"
  type        = string
  default     = "dbadmin"
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GB"
  type        = number
  default     = 20
}

variable "lambda_runtime" {
  description = "Lambda Node.js runtime"
  type        = string
  default     = "nodejs20.x"
}

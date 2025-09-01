# Math Data Foundry — AWS Architecture & Development Plan

## 1. Goals & Constraints

* Full **AWS-native** deployment (no external platforms).
* Multi-annotator system with **Cognito authentication** and dataset-level access control.
* Datasets function as repositories; annotators choose a dataset to submit work.
* Submission fields:

  * Username or email (default username).
  * Labels (multi-select: Algebra, Number Theory, Combinatorics, etc.).
  * Original or Variation (if variation, require source).
  * **Problem (plain text/markdown)** (mandatory).
  * **Problem LaTeX** (optional, can be attached later).
  * **Solution (plain text/markdown)** (mandatory).
  * **Solution LaTeX** (optional; can be attached later).
  * **Lean4 code** (optional; can be attached later).
* Admin can view all submissions, manage datasets, memberships, and retrieve data.
* Annotators see only their assigned datasets and submissions.
* Problems, solutions, and Lean4 stored in **separate S3 buckets**, linked with a shared `ProblemId`.

---

## 2. High-Level Architecture

```
Users
  |  Cognito (sign in, JWT tokens)
  v
CloudFront (public URL)
  -> S3 (static frontend hosting)

Frontend calls -> API Gateway (REST)
                   | Cognito Authorizer
                   v
                Lambda Functions
                   |-> DynamoDB (metadata)
                   |-> S3 (3 buckets: problems, solutions, lean4)
                   |-> EventBridge/SNS/SES (notifications)

Admin & Analytics
  -> Athena + Glue on S3 exports

Security & Observability
  -> IAM, CloudWatch, CloudTrail, WAF
```

---

## 3. Core AWS Services

* **Amazon Cognito**: user management, groups (Admin, Annotator).
* **Amazon S3 (x3)**: problems, solutions, Lean4 code (encrypted, versioned).
* **Amazon DynamoDB**: submissions, datasets, memberships.
* **Amazon API Gateway**: REST API with Cognito authorizer.
* **AWS Lambda**: API logic, presigned URL handling.
* **Amazon CloudFront + S3**: frontend hosting.
* **Amazon WAF**: protection against attacks.
* **Amazon EventBridge + SNS/SES**: notify admins of new submissions.
* **AWS Glue + Athena**: analytics and dataset export.
* **AWS CodePipeline/CodeBuild**: CI/CD.

---

## 4. Identity & Access

* Cognito User Pool groups:

  * `admin`: full access.
  * `annotator`: restricted access.
* Memberships stored in DynamoDB (datasetId ↔ userId mapping).
* Lambda enforces access control.
* S3 uploads/downloads via presigned URLs.

---

## 5. Data Model (DynamoDB)

**Table: `mdf-core`**

* **Dataset**: `pk=DATASET#<datasetId>`, `sk=PROFILE`.
* **Membership**: `pk=DATASET#<datasetId>`, `sk=MEMBER#<userId>`.
* **Problem**: `pk=DATASET#<datasetId>`, `sk=PROBLEM#<problemId>`.

  ```json
  {
    "problemId": "UUID",
    "submittedBy": "userId",
    "username": "...",
    "email": "...",
    "labels": ["algebra"],
    "originality": "original|variation",
    "variationSource": "source",
    "s3Keys": {
      "problemLatex": "s3://mdf-problems/...",
      "solutionLatex": "s3://mdf-solutions/...",
      "plainSolution": "s3://mdf-solutions/..."
    },
    "lean4": {"attached": false, "s3Key": null},
    "review": {"state": "pending", "by": null, "at": null},
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601"
  }
  ```
* **GSIs**: user submissions, review queue, label search.

---

## 6. S3 Layout

* `mdf-problems/<datasetId>/<problemId>.tex`
* `mdf-solutions/<datasetId>/<problemId>.tex` (+ optional `.md`)
* `mdf-lean4/<datasetId>/<problemId>.lean`
* `mdf-exports/` (Athena export parquet files)

---

## 7. Submission Flow

1. Annotator logs in (Cognito).
2. Chooses dataset → opens submission form.
3. Frontend requests problem creation → Lambda generates `problemId`, presigned URLs.
4. Frontend uploads LaTeX files to S3.
5. Finalize call → Lambda validates & marks `pending`.
6. Admin notified via EventBridge → SNS/SES.
7. Annotator may later attach Lean4 code.

---

## 8. Frontend Features

* **Annotator**: dataset list, submission form, list my submissions, attach Lean4.
* **Admin**: all datasets, filters (label, user, status), approve/reject, manage memberships, export.

---

## 9. REST API

* `GET /me` → profile, memberships.
* `GET /datasets` → list datasets.
* `POST /datasets` (admin).
* `POST /datasets/{id}/members` (admin).
* `GET /datasets/{id}/problems` → list submissions.
* `POST /datasets/{id}/problems` → create draft.
* `POST /problems/{id}/finalize` → validate.
* `PUT /problems/{id}/lean4` → attach Lean4.
* `GET /problems/{id}` → details + signed URLs.
* `POST /problems/search` → advanced filters.
* `POST /admin/export` → export dataset.

---

## 10. Infrastructure as Code

* **AWS CDK v2 (TypeScript)**:

  * Cognito User Pool & groups.
  * DynamoDB table + GSIs.
  * S3 buckets.
  * API Gateway + Lambdas.
  * CloudFront + S3 static hosting.
  * EventBridge + SNS.
  * CloudWatch alarms.
  * WAF.

---

## 11. Security

* KMS encryption for DynamoDB + S3.
* IAM least privilege.
* WAF protection.
* Validation in Lambda.
* CloudTrail logging.
* DynamoDB PITR + S3 versioning.

---

## 12. Cost Controls

* Serverless = pay-per-use.
* Lifecycle policies: IA after 30d, Deep Archive after 180d.
* DynamoDB On-Demand.
* CloudFront caching.

---

## 13. Deployment Checklist

1. `cdk bootstrap` → prepare environment.
2. `cdk deploy` → deploy stack.
3. Configure Cognito (admin + annotators).
4. Build frontend → deploy to S3 → invalidate CloudFront.
5. Deploy backend Lambdas.
6. Route53 domain → CloudFront.
7. WAF + SSL cert.
8. Smoke test (sign in, submit, approve).
9. Set up monitoring/alarms.

---

## 14. Milestones

* **M1**: Auth, dataset CRUD, submissions (problems + solutions).
* **M2**: Review workflow, notifications, search.
* **M3**: Lean4 attachments, exports.
* **M4**: LaTeX previews, WAF, alarms.
* **M5**: Analytics (Athena, QuickSight).

---

## 15. Example Objects

* **Problem LaTeX**:

```
% Problem ID: <id>
\begin{problem}
Prove that ...
\end{problem}
```

* **Solution LaTeX**:

```
% Solution for <id>
\begin{solution}
...
\end{solution}
```

* **Lean4**:

```lean
-- Problem <id>
-- Lean4 proof code
```

---

## 16. Public URL

Use a public AWS URL
---

## 17. Next Steps

* Confirm AWS region & domain.
* Bootstrap CDK & deploy initial stack.
* Build minimal API + frontend → deliver M1.

---

## 18. Google Sign‑In (Federation) & Admin account

### Overview

Annotators will be able to sign in using either:

* Email/password (Cognito user pool), or
* **Sign in with Google** (OAuth2 / OpenID Connect federation through Cognito).

The system will also register an initial admin account for `renzo.balcazar.1@gmail.com` (the provided Google account) and place it in the Cognito `admin` group so the account has full administrative privileges.

### Implementation notes

* **Cognito Identity Provider (IdP) — Google**

  * Register your app in Google Cloud Console to obtain a **Client ID** and **Client Secret**.
  * Store the Google Client ID/Secret in **AWS Secrets Manager** and inject them into Cognito via CDK during deployment.
  * Configure a Cognito **User Pool Identity Provider** for Google and add it to the User Pool's App Client(s).
  * Configure the Cognito Hosted UI to show a “Sign in with Google” button.

* **Admin account (initial)**

  * Because federated users (Google) appear in the Cognito User Pool only after their first successful sign‑in, we will **pre‑create a Cognito user** matching `renzo.balcazar.1@gmail.com` and mark `email_verified = true`. Then attach that user to the `admin` group.
  * This guarantees the email is present in the user pool immediately and that the user has `admin` privileges on first sign‑in (either via password or Google OAuth).
  * If you prefer to rely purely on federation (no pre‑created user), we can instead detect the first federated sign‑in via a post‑authentication Lambda trigger and add the `admin` group membership then — however CDK pre‑creation ensures the admin exists from the start.

### Security considerations

* Protect the Google client secret in **Secrets Manager** with a KMS key and restrict access to only the CDK deploy role and the Cognito service where needed.
* Ensure `email_verified` is set when pre‑creating the admin user to avoid account takeover possibilities.
* Limit admin creation: the CDK or deployment script should only create the initial admin user. Further admin additions should be done via the Admin UI.

### UX

* The frontend’s login page will expose a standard Cognito Hosted UI link with `identity_provider=Google` to initiate the OAuth flow. The Hosted UI will return a Cognito JWT which the frontend uses to call the API.

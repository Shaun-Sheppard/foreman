//! Azure DevOps REST client (api-version 7.1, PAT auth).

pub mod fixture;
pub mod model;
pub mod wiql;

use std::time::Duration;

use reqwest::{header, Method, StatusCode, Url};
use serde::Serialize;
use serde_json::{json, Value};

use model::{Comment, LinkedItem, Person, Sprint, WorkItem};

const API: &str = "7.1";
const BATCH_SIZE: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Unauthorized,
    Forbidden,
    NotFound,
    RateLimited,
    Server,
    Network,
    Invalid,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct DevOpsError {
    pub kind: ErrorKind,
    pub message: String,
    /// Seconds the server asked us to wait (`Retry-After`).
    #[serde(skip)]
    pub retry_after: Option<u64>,
}

impl DevOpsError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), retry_after: None }
    }

    /// Worth retrying sooner than the next normal poll, with back-off.
    pub fn is_transient(&self) -> bool {
        matches!(self.kind, ErrorKind::RateLimited | ErrorKind::Server | ErrorKind::Network)
    }
}

pub type Result<T> = std::result::Result<T, DevOpsError>;

pub struct Client {
    http: reqwest::Client,
    base: Url,
    pat: String,
    fixture: bool,
}

impl Client {
    pub fn new(org_url: &str, pat: &str, fixture: bool) -> Result<Self> {
        let trimmed = org_url.trim().trim_end_matches('/');
        let base = Url::parse(trimmed)
            .ok()
            .filter(|u| u.scheme() == "https" && u.host_str().is_some())
            .ok_or_else(|| {
                DevOpsError::new(
                    ErrorKind::Invalid,
                    "Organisation URL must look like https://dev.azure.com/your-org",
                )
            })?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Foreman/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| DevOpsError::new(ErrorKind::Network, format!("Couldn't start HTTP client: {e}")))?;
        Ok(Self { http, base, pat: pat.to_string(), fixture })
    }

    fn url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut().expect("https URL").pop_if_empty().extend(segments);
        url.query_pairs_mut().extend_pairs(query);
        url
    }

    async fn send(&self, method: Method, url: Url, body: Option<Value>) -> Result<Value> {
        if self.fixture {
            return fixture::respond(&url, body.as_ref());
        }
        let mut req = self
            .http
            .request(method, url)
            .basic_auth("", Some(&self.pat))
            .header(header::ACCEPT, "application/json");
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().await.map_err(|e| {
            let what = if e.is_timeout() {
                "Azure DevOps didn't respond in time"
            } else if e.is_connect() {
                "Couldn't reach Azure DevOps — check your network"
            } else {
                "Network error talking to Azure DevOps"
            };
            DevOpsError::new(ErrorKind::Network, what)
        })?;

        let status = resp.status();
        let retry_after = resp
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let is_json = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("json"));

        // A bad PAT can come back as 203 with the HTML sign-in page rather than a 401.
        if status == StatusCode::UNAUTHORIZED
            || status == StatusCode::NON_AUTHORITATIVE_INFORMATION
            || (status.is_success() && !is_json)
        {
            return Err(DevOpsError::new(
                ErrorKind::Unauthorized,
                "Personal access token was rejected (wrong, expired or revoked)",
            ));
        }
        if status.is_success() {
            return resp
                .json()
                .await
                .map_err(|_| DevOpsError::new(ErrorKind::Server, "Azure DevOps sent a response Foreman couldn't read"));
        }

        let detail = resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string));
        let (kind, message) = match status {
            StatusCode::FORBIDDEN => (
                ErrorKind::Forbidden,
                "The token doesn't have access — check its scopes (Work Items, Code, Build)".to_string(),
            ),
            StatusCode::NOT_FOUND => (
                ErrorKind::NotFound,
                detail.clone().unwrap_or_else(|| "Organisation or project not found — check the URL and project name".into()),
            ),
            StatusCode::TOO_MANY_REQUESTS => (ErrorKind::RateLimited, "Azure DevOps is rate-limiting requests".to_string()),
            s if s.is_server_error() => (ErrorKind::Server, format!("Azure DevOps is having problems (HTTP {})", s.as_u16())),
            s => (
                ErrorKind::Invalid,
                detail.clone().unwrap_or_else(|| format!("Azure DevOps rejected the request (HTTP {})", s.as_u16())),
            ),
        };
        Err(DevOpsError { kind, message, retry_after })
    }

    /// Plain-text GET, for build logs.
    async fn get_text(&self, url: Url) -> Result<String> {
        if self.fixture {
            return fixture::respond(&url, None).map(|v| v.as_str().unwrap_or_default().to_string());
        }
        let resp = self
            .http
            .get(url)
            .basic_auth("", Some(&self.pat))
            .send()
            .await
            .map_err(|_| DevOpsError::new(ErrorKind::Network, "Network error talking to Azure DevOps"))?;
        if !resp.status().is_success() {
            return Err(DevOpsError::new(ErrorKind::Server, format!("Couldn't download the build log (HTTP {})", resp.status().as_u16())));
        }
        resp.text().await.map_err(|_| DevOpsError::new(ErrorKind::Server, "Couldn't read the build log"))
    }

    fn pr_segments<'a>(project: &'a str, repo_id: &'a str, pr_id: &'a str) -> [&'a str; 7] {
        [project, "_apis", "git", "repositories", repo_id, "pullrequests", pr_id]
    }

    /// Pull requests in the project whose source branch is `branch`, any status.
    pub async fn prs_for_branch(&self, project: &str, branch: &str) -> Result<Vec<Value>> {
        let source = format!("refs/heads/{branch}");
        let url = self.url(
            &[project, "_apis", "git", "pullrequests"],
            &[("searchCriteria.sourceRefName", &source), ("searchCriteria.status", "all"), ("$top", "10"), ("api-version", API)],
        );
        let v = self.send(Method::GET, url, None).await?;
        Ok(v.get("value").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    pub async fn pull_request(&self, project: &str, repo_id: &str, pr_id: u64) -> Result<Value> {
        let id = pr_id.to_string();
        let url = self.url(&Self::pr_segments(project, repo_id, &id), &[("api-version", API)]);
        self.send(Method::GET, url, None).await
    }

    /// Branch policy evaluations for a PR (build validation and other required policies).
    pub async fn policy_evaluations(&self, project: &str, project_id: &str, pr_id: u64) -> Result<Vec<Value>> {
        let artifact = format!("vstfs:///CodeReview/CodeReviewId/{project_id}/{pr_id}");
        let url = self.url(
            &[project, "_apis", "policy", "evaluations"],
            &[("artifactId", &artifact), ("api-version", "7.1-preview.1")],
        );
        let v = self.send(Method::GET, url, None).await?;
        Ok(v.get("value").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    pub async fn pr_threads(&self, project: &str, repo_id: &str, pr_id: u64) -> Result<Vec<Value>> {
        let id = pr_id.to_string();
        let mut segments = Self::pr_segments(project, repo_id, &id).to_vec();
        segments.push("threads");
        let v = self.send(Method::GET, self.url(&segments, &[("api-version", API)]), None).await?;
        Ok(v.get("value").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    #[allow(clippy::too_many_arguments)]
    /// Completes (merges) a PR at the given source commit (FR6.1). DevOps refuses if the
    /// branch has moved on since, so the merge can never cover unseen commits.
    pub async fn complete_pull_request(
        &self,
        project: &str,
        repo_id: &str,
        pr_id: u64,
        source_commit: &str,
        strategy: &str,
        delete_source_branch: bool,
        transition_work_items: bool,
    ) -> Result<Value> {
        let id = pr_id.to_string();
        let url = self.url(&Self::pr_segments(project, repo_id, &id), &[("api-version", API)]);
        let body = json!({
            "status": "completed",
            "lastMergeSourceCommit": { "commitId": source_commit },
            "completionOptions": {
                "mergeStrategy": strategy,
                "deleteSourceBranch": delete_source_branch,
                "transitionWorkItems": transition_work_items,
            },
        });
        self.send(Method::PATCH, url, Some(body)).await
    }

    /// Replies to a review thread and marks it fixed (FR5.2).
    pub async fn resolve_thread(&self, project: &str, repo_id: &str, pr_id: u64, thread_id: u64, reply: &str) -> Result<()> {
        let (id, thread) = (pr_id.to_string(), thread_id.to_string());
        let mut segments = Self::pr_segments(project, repo_id, &id).to_vec();
        segments.extend(["threads", &thread]);
        let mut comments = segments.clone();
        comments.push("comments");
        let body = json!({ "content": reply, "parentCommentId": 1, "commentType": 1 });
        self.send(Method::POST, self.url(&comments, &[("api-version", API)]), Some(body)).await?;
        self.send(Method::PATCH, self.url(&segments, &[("api-version", API)]), Some(json!({ "status": "fixed" }))).await?;
        Ok(())
    }

    /// The first failed task of a build and its log text (FR4.4).
    pub async fn failed_task_log(&self, project: &str, build_id: u64) -> Result<Option<(String, String)>> {
        let build = build_id.to_string();
        let base = [project, "_apis", "build", "builds", &build];
        let mut timeline = base.to_vec();
        timeline.push("timeline");
        let v = self.send(Method::GET, self.url(&timeline, &[("api-version", API)]), None).await?;
        let failed = v.get("records").and_then(Value::as_array).and_then(|records| {
            records.iter().find(|r| {
                r.get("type").and_then(Value::as_str) == Some("Task")
                    && r.get("result").and_then(Value::as_str) == Some("failed")
                    && r.pointer("/log/id").is_some()
            })
        });
        let Some(task) = failed else {
            return Ok(None);
        };
        let name = task.get("name").and_then(Value::as_str).unwrap_or("Build task").to_string();
        let log_id = task.pointer("/log/id").and_then(Value::as_u64).unwrap_or_default().to_string();
        let mut log = base.to_vec();
        log.extend(["logs", &log_id]);
        let text = self.get_text(self.url(&log, &[("api-version", API)])).await?;
        Ok(Some((name, text)))
    }

    /// Who the PAT belongs to. Doubles as the cheapest authentication check.
    pub async fn me(&self) -> Result<Person> {
        let url = self.url(&["_apis", "connectionData"], &[("api-version", "7.1-preview")]);
        let v = self.send(Method::GET, url, None).await?;
        let user = v.get("authenticatedUser").unwrap_or(&Value::Null);
        let display_name = user
            .get("providerDisplayName")
            .or_else(|| user.get("customDisplayName"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown user")
            .to_string();
        let unique_name = user
            .pointer("/properties/Account/$value")
            .and_then(Value::as_str)
            .unwrap_or(&display_name)
            .to_string();
        Ok(Person { display_name, unique_name })
    }

    /// Iterations of the project's default team, oldest first.
    pub async fn sprints(&self, project: &str, current_only: bool) -> Result<Vec<Sprint>> {
        let mut query = vec![("api-version", API)];
        if current_only {
            query.push(("$timeframe", "current"));
        }
        let url = self.url(&[project, "_apis", "work", "teamsettings", "iterations"], &query);
        let v = self.send(Method::GET, url, None).await.map_err(|mut e| {
            if e.kind == ErrorKind::NotFound {
                e.message = format!("Project \"{project}\" wasn't found in this organisation");
            }
            e
        })?;
        let s = |x: &Value, p: &str| x.pointer(p).and_then(Value::as_str).map(str::to_string);
        Ok(v.get("value")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|it| {
                        Some(Sprint {
                            path: s(it, "/path")?,
                            name: s(it, "/name")?,
                            project: project.to_string(),
                            time_frame: s(it, "/attributes/timeFrame").unwrap_or_else(|| "future".into()),
                            start_date: s(it, "/attributes/startDate"),
                            finish_date: s(it, "/attributes/finishDate"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn query_ids(&self, wiql: &str) -> Result<Vec<u64>> {
        let url = self.url(&["_apis", "wit", "wiql"], &[("api-version", API)]);
        let v = self.send(Method::POST, url, Some(json!({ "query": wiql }))).await?;
        Ok(v.get("workItems")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|w| w.get("id").and_then(Value::as_u64)).collect())
            .unwrap_or_default())
    }

    async fn batch(&self, ids: &[u64], body: Value) -> Result<Vec<Value>> {
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(BATCH_SIZE) {
            let url = self.url(&["_apis", "wit", "workitemsbatch"], &[("api-version", API)]);
            let mut body = body.clone();
            body["ids"] = json!(chunk);
            body["errorPolicy"] = json!("Omit");
            let v = self.send(Method::POST, url, Some(body)).await?;
            if let Some(items) = v.get("value").and_then(Value::as_array) {
                out.extend(items.iter().filter(|i| !i.is_null()).cloned());
            }
        }
        Ok(out)
    }

    /// Full details for the given IDs, in the order given (FR1.1: batches of up to 200).
    pub async fn work_items(&self, ids: &[u64]) -> Result<Vec<WorkItem>> {
        let raw = self.batch(ids, json!({ "$expand": "Relations" })).await?;
        let mut items: Vec<WorkItem> = raw.iter().filter_map(model::parse_work_item).collect();
        items.sort_by_key(|i| ids.iter().position(|id| *id == i.id).unwrap_or(usize::MAX));
        Ok(items)
    }

    /// Distinct assignees of the given items.
    pub async fn assignees(&self, ids: &[u64]) -> Result<Vec<Person>> {
        let raw = self.batch(ids, json!({ "fields": ["System.AssignedTo"] })).await?;
        let mut people: Vec<Person> = vec![];
        for v in &raw {
            if let Some(p) = v.pointer("/fields/System.AssignedTo").and_then(model::parse_person) {
                if !people.contains(&p) {
                    people.push(p);
                }
            }
        }
        people.sort_by_key(|p| p.display_name.to_lowercase());
        Ok(people)
    }

    pub async fn linked_items(&self, links: &[model::Link]) -> Result<Vec<LinkedItem>> {
        let ids: Vec<u64> = links.iter().map(|l| l.id).collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let fields = json!({ "fields": ["System.Title", "System.WorkItemType", "System.State"] });
        let raw = self.batch(&ids, fields).await?;
        let field = |v: &Value, k: &str| {
            v.pointer(&format!("/fields/{k}")).and_then(Value::as_str).unwrap_or_default().to_string()
        };
        Ok(links
            .iter()
            .filter_map(|l| {
                let v = raw.iter().find(|v| v.get("id").and_then(Value::as_u64) == Some(l.id))?;
                Some(LinkedItem {
                    id: l.id,
                    rel: l.rel.clone(),
                    title: field(v, "System.Title"),
                    kind: field(v, "System.WorkItemType"),
                    state: field(v, "System.State"),
                })
            })
            .collect())
    }

    /// Latest comments, newest first.
    pub async fn comments(&self, project: &str, id: u64, top: u32) -> Result<Vec<Comment>> {
        let top = top.to_string();
        let url = self.url(
            &[project, "_apis", "wit", "workItems", &id.to_string(), "comments"],
            &[("$top", &top), ("order", "desc"), ("api-version", "7.1-preview.4")],
        );
        let v = self.send(Method::GET, url, None).await?;
        let s = |x: &Value, p: &str| x.pointer(p).and_then(Value::as_str).unwrap_or_default().to_string();
        Ok(v.get("comments")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|c| Comment {
                        author: s(c, "/createdBy/displayName"),
                        date: s(c, "/createdDate"),
                        html: s(c, "/text"),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https_org_url() {
        assert!(Client::new("http://dev.azure.com/x", "p", false).is_err());
        assert!(Client::new("dev.azure.com/x", "p", false).is_err());
        assert!(Client::new("https://dev.azure.com/x/", "p", false).is_ok());
    }

    #[test]
    fn urls_encode_project_names() {
        let c = Client::new("https://dev.azure.com/org", "p", false).unwrap();
        let u = c.url(&["Clinical Platform", "_apis", "wit", "wiql"], &[("api-version", API)]);
        assert_eq!(u.as_str(), "https://dev.azure.com/org/Clinical%20Platform/_apis/wit/wiql?api-version=7.1");
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub display_name: String,
    pub unique_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub rel: String,
    pub id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: u64,
    pub rev: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub state: String,
    pub assigned_to: Option<Person>,
    pub iteration_path: String,
    pub area_path: String,
    pub project: String,
    pub priority: Option<u64>,
    pub changed_date: String,
    /// Untrusted HTML from DevOps; the webview sanitises it before display.
    pub description_html: String,
    pub acceptance_html: String,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprint {
    pub path: String,
    pub name: String,
    pub project: String,
    /// `past`, `current` or `future`.
    pub time_frame: String,
    pub start_date: Option<String>,
    pub finish_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub author: String,
    pub date: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedItem {
    pub id: u64,
    pub rel: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub state: String,
}

fn text(fields: &Value, key: &str) -> String {
    fields.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn parse_person(v: &Value) -> Option<Person> {
    let display_name = v.get("displayName")?.as_str()?.to_string();
    let unique_name = v.get("uniqueName").and_then(Value::as_str).unwrap_or(&display_name).to_string();
    Some(Person { display_name, unique_name })
}

/// Friendly name for a link relation, e.g. `System.LinkTypes.Hierarchy-Reverse` → `Parent`.
fn relation_name(rel: &Value) -> String {
    rel.pointer("/attributes/name")
        .and_then(Value::as_str)
        .or_else(|| rel.get("rel").and_then(Value::as_str))
        .unwrap_or("Related")
        .to_string()
}

fn linked_id(url: &str) -> Option<u64> {
    let (head, tail) = url.rsplit_once('/')?;
    if !head.to_ascii_lowercase().ends_with("/workitems") {
        return None;
    }
    tail.parse().ok()
}

pub fn parse_work_item(v: &Value) -> Option<WorkItem> {
    let id = v.get("id")?.as_u64()?;
    let f = v.get("fields")?;
    let mut description_html = text(f, "System.Description");
    if description_html.trim().is_empty() {
        // Bugs usually carry their detail in repro steps instead.
        description_html = text(f, "Microsoft.VSTS.TCM.ReproSteps");
    }
    let links = v
        .get("relations")
        .and_then(Value::as_array)
        .map(|rels| {
            rels.iter()
                .filter_map(|r| {
                    let id = linked_id(r.get("url")?.as_str()?)?;
                    Some(Link { rel: relation_name(r), id })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(WorkItem {
        id,
        rev: v.get("rev").and_then(Value::as_u64).unwrap_or(0),
        kind: text(f, "System.WorkItemType"),
        title: text(f, "System.Title"),
        state: text(f, "System.State"),
        assigned_to: f.get("System.AssignedTo").and_then(parse_person),
        iteration_path: text(f, "System.IterationPath"),
        area_path: text(f, "System.AreaPath"),
        project: text(f, "System.TeamProject"),
        priority: f.get("Microsoft.VSTS.Common.Priority").and_then(Value::as_u64),
        changed_date: text(f, "System.ChangedDate"),
        description_html,
        acceptance_html: text(f, "Microsoft.VSTS.Common.AcceptanceCriteria"),
        links,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_fields_and_links() {
        let v = json!({
            "id": 4512, "rev": 7,
            "fields": {
                "System.WorkItemType": "Task", "System.Title": "Add validation", "System.State": "Active",
                "System.AssignedTo": { "displayName": "Shaun Sheppard", "uniqueName": "ss@example.com" },
                "System.IterationPath": "P\\Sprint 42", "System.AreaPath": "P\\Intake", "System.TeamProject": "P",
                "Microsoft.VSTS.Common.Priority": 2, "System.ChangedDate": "2026-10-09T10:00:00Z",
                "System.Description": "<p>Hi</p>"
            },
            "relations": [
                { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://dev.azure.com/o/_apis/wit/workItems/4400", "attributes": { "name": "Parent" } },
                { "rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/abc", "attributes": { "name": "Pull Request" } }
            ]
        });
        let item = parse_work_item(&v).unwrap();
        assert_eq!(item.id, 4512);
        assert_eq!(item.kind, "Task");
        assert_eq!(item.assigned_to.unwrap().unique_name, "ss@example.com");
        assert_eq!(item.priority, Some(2));
        assert_eq!(item.links, vec![Link { rel: "Parent".into(), id: 4400 }]);
    }

    #[test]
    fn bug_falls_back_to_repro_steps_and_tolerates_unassigned() {
        let v = json!({ "id": 1, "fields": { "System.WorkItemType": "Bug", "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>x</li></ol>" } });
        let item = parse_work_item(&v).unwrap();
        assert!(item.assigned_to.is_none());
        assert_eq!(item.description_html, "<ol><li>x</li></ol>");
    }
}

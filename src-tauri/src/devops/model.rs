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

#[derive(Debug, Clone, PartialEq)]
pub struct ChildState {
    pub id: u64,
    pub assignee: Option<String>,
    pub state: String,
}

const CHILD_LINK: &str = "Child";

impl WorkItem {
    pub fn child_ids(&self) -> impl Iterator<Item = u64> + '_ {
        self.links.iter().filter(|l| l.rel == CHILD_LINK).map(|l| l.id)
    }
}

/// Drops items whose assignee has finished their part: they have child tasks of their own
/// on the item and none is still in a to-do state (e.g. their Dev task is In Review). An item
/// where the assignee has no child task at all is kept, since the work may sit on the item itself.
pub fn without_finished_parents(items: Vec<WorkItem>, children: &[ChildState], todo_states: &[String]) -> Vec<WorkItem> {
    items
        .into_iter()
        .filter(|item| {
            let Some(owner) = item.assigned_to.as_ref().map(|p| p.unique_name.to_lowercase()) else {
                return true;
            };
            let mine: Vec<&ChildState> = item
                .child_ids()
                .filter_map(|id| children.iter().find(|c| c.id == id))
                .filter(|c| c.assignee.as_ref().is_some_and(|a| a.to_lowercase() == owner))
                .collect();
            mine.is_empty() || mine.iter().any(|c| todo_states.contains(&c.state))
        })
        .collect()
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
    fn parents_are_hidden_once_the_assignees_own_tasks_are_done() {
        let me = Person { display_name: "Shaun".into(), unique_name: "SS@example.com".into() };
        let parent = |id: u64, kids: &[u64]| WorkItem {
            id, rev: 1, kind: "User Story".into(), title: String::new(), state: "New".into(), assigned_to: Some(me.clone()),
            iteration_path: String::new(), area_path: String::new(), project: String::new(), priority: None,
            changed_date: String::new(), description_html: String::new(), acceptance_html: String::new(),
            links: kids.iter().map(|k| Link { rel: "Child".into(), id: *k }).chain([Link { rel: "Related".into(), id: 900 }]).collect(),
        };
        let child = |id: u64, who: &str, state: &str| ChildState { id, assignee: Some(who.into()), state: state.into() };
        let children = [
            child(10, "ss@example.com", "In Review"), // mine, finished
            child(11, "jon@example.com", "To Do"),    // someone else's QA task
            child(20, "ss@example.com", "In Review"),
            child(21, "ss@example.com", "To Do"),     // I still have work here
            child(30, "jon@example.com", "To Do"),    // only other people's tasks
            child(900, "ss@example.com", "Done"),     // related, not a child
        ];
        let todo = vec!["New".to_string(), "To Do".to_string(), "In Progress".to_string()];
        let items = vec![parent(1, &[10, 11]), parent(2, &[20, 21]), parent(3, &[30]), parent(4, &[])];
        let kept: Vec<u64> = without_finished_parents(items, &children, &todo).iter().map(|i| i.id).collect();
        assert_eq!(kept, vec![2, 3, 4]);
    }

    #[test]
    fn bug_falls_back_to_repro_steps_and_tolerates_unassigned() {
        let v = json!({ "id": 1, "fields": { "System.WorkItemType": "Bug", "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>x</li></ol>" } });
        let item = parse_work_item(&v).unwrap();
        assert!(item.assigned_to.is_none());
        assert_eq!(item.description_html, "<ol><li>x</li></ol>");
    }
}

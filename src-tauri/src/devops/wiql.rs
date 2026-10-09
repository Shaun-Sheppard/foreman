//! Builds the WIQL query for the current filters (FR1.1).

use crate::settings::{PERSON_EVERYONE, PERSON_ME};

pub struct Query<'a> {
    pub projects: &'a [String],
    /// Resolved iteration paths (never the `@current` placeholder).
    pub iteration_paths: &'a [String],
    pub person: &'a str,
    pub types: &'a [String],
    pub states: &'a [String],
    pub area_paths: &'a [String],
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn in_list(field: &str, values: &[String]) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let list: Vec<String> = values.iter().map(|v| quote(v)).collect();
    Some(format!("[{field}] IN ({})", list.join(", ")))
}

fn any_of(field: &str, op: &str, values: &[String]) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let parts: Vec<String> = values.iter().map(|v| format!("[{field}] {op} {}", quote(v))).collect();
    Some(if parts.len() == 1 { parts[0].clone() } else { format!("({})", parts.join(" OR ")) })
}

pub fn build(q: &Query) -> String {
    let mut clauses: Vec<String> = vec![];
    clauses.extend(in_list("System.TeamProject", q.projects));
    clauses.extend(any_of("System.IterationPath", "=", q.iteration_paths));
    match q.person {
        PERSON_EVERYONE => {}
        PERSON_ME | "" => clauses.push("[System.AssignedTo] = @Me".into()),
        who => clauses.push(format!("[System.AssignedTo] = {}", quote(who))),
    }
    clauses.extend(in_list("System.WorkItemType", q.types));
    clauses.extend(in_list("System.State", q.states));
    clauses.extend(any_of("System.AreaPath", "UNDER", q.area_paths));

    let mut sql = String::from("SELECT [System.Id] FROM WorkItems");
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC");
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn full_query_for_me() {
        let sql = build(&Query {
            projects: &v(&["Clinical Platform"]),
            iteration_paths: &v(&["Clinical Platform\\Sprint 42"]),
            person: PERSON_ME,
            types: &v(&["Bug", "Task"]),
            states: &v(&["New", "Active"]),
            area_paths: &v(&["Clinical\\Intake", "Clinical\\Referrals"]),
        });
        assert_eq!(
            sql,
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] IN ('Clinical Platform') \
             AND [System.IterationPath] = 'Clinical Platform\\Sprint 42' \
             AND [System.AssignedTo] = @Me \
             AND [System.WorkItemType] IN ('Bug', 'Task') \
             AND [System.State] IN ('New', 'Active') \
             AND ([System.AreaPath] UNDER 'Clinical\\Intake' OR [System.AreaPath] UNDER 'Clinical\\Referrals') \
             ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC"
        );
    }

    #[test]
    fn everyone_has_no_assignee_clause() {
        let sql = build(&Query {
            projects: &v(&["P"]),
            iteration_paths: &[],
            person: PERSON_EVERYONE,
            types: &[],
            states: &[],
            area_paths: &[],
        });
        assert!(!sql.contains("AssignedTo"));
        assert!(sql.starts_with("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] IN ('P') ORDER BY"));
    }

    #[test]
    fn specific_person_and_multiple_sprints() {
        let sql = build(&Query {
            projects: &v(&["A", "B"]),
            iteration_paths: &v(&["A\\S1", "B\\S1"]),
            person: "priya@example.com",
            types: &[],
            states: &[],
            area_paths: &[],
        });
        assert!(sql.contains("[System.TeamProject] IN ('A', 'B')"));
        assert!(sql.contains("([System.IterationPath] = 'A\\S1' OR [System.IterationPath] = 'B\\S1')"));
        assert!(sql.contains("[System.AssignedTo] = 'priya@example.com'"));
    }

    #[test]
    fn quotes_are_escaped() {
        let sql = build(&Query {
            projects: &v(&["O'Brien's project"]),
            iteration_paths: &[],
            person: "x' OR 1=1 --",
            types: &[],
            states: &[],
            area_paths: &[],
        });
        assert!(sql.contains("IN ('O''Brien''s project')"));
        assert!(sql.contains("[System.AssignedTo] = 'x'' OR 1=1 --'"));
    }

    #[test]
    fn no_filters_has_no_where() {
        let sql = build(&Query {
            projects: &[],
            iteration_paths: &[],
            person: PERSON_EVERYONE,
            types: &[],
            states: &[],
            area_paths: &[],
        });
        assert!(!sql.contains("WHERE"));
    }
}

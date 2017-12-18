# Trello scripts

## Meal plan

A script to
- reset all cards into backlog every week
- rearrange boards every day so that current day is always the leftmost

## Tasks

### Due tasks

Run with `node index.js due`

Moves all tasks that are due today into "Today" list

### Tomorrow tasks

Run with `node index.js tomorrow`

Moves all tasks from "Tomorrow" list into "Today" list

### Recurring tasks

Run with `node index.js recurring`

Creates recurring tasks on specific days of the week

Config is in recurring.json in this format:
```
[{
    "name": "gym",
    "daysOfWeek": [1, 3, 5],
    "labels": ["ID"]
}, {
    "name": "do stuff",
    "daysOfWeek": [0],
    "labels": ["ID"]
}]
```

'use strict';

console.log('Loading function');

const RP = require('request-promise-native');
const fs = require('fs');

var config = require('yaml-env-config')('.');
for (let [key, val] of Object.entries(config.app.env_variables)) {
    process.env[key] = val;
}

//
// Configuration
//
const TRELLO_API_URL = 'https://api.trello.com/1';
const MEAL_BOARD_ID = process.env.TRELLO_MEAL_BOARD_ID;
const TODO_BOARD_ID = process.env.TRELLO_TODO_BOARD_ID;
const TRELLO_API_TOKEN = process.env.TRELLO_API_TOKEN;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_API_AUTH = '&key=' + TRELLO_API_KEY + '&token=' + TRELLO_API_TOKEN;
const RESET_DAY = 6; // Sunday
const NAME_BACKLOG_COLUMN = "Backlog";
const NAME_TODAY_COLUMN = "Today";
const NAME_TOMORROW_COLUMN = "Tomorrow";
const NAME_DONE_COLUMN = "Done";

const TODOIST_API_URL = 'https://beta.todoist.com/API/v8';
const TODOIST_SYNC_API_URL = 'https://beta.todoist.com/API/v7';
const TODOIST_API_KEY = process.env.TODOIST_API_KEY;
const TODOIST_INBOX_ID = process.env.TODOIST_INBOX_ID;
const TRELLO_TODOIST_LABEL = process.env.TRELLO_TODOIST_LABEL;
const TODOIST_SYNC_TOKEN_FILE = '.todoist_sync_token';

let DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

module.exports.meal = (event, context, callback) => {

    // Get the current day
    const day = (new Date().getDay() + 6) % 7;
    const currentDay = DAYS_OF_WEEK[day];

    // Reset the board if it's the reset day
    if (day === RESET_DAY) {
        resetBoard();   
    }
    orderBoard(currentDay);
}

module.exports.due = (event, context, callback) => {
    moveDue();
}

module.exports.tomorrow = (event, context, callback) => {
    moveTomorrowToToday();
}

module.exports.recurring = (event, context, callback) => {
    addRecurringTasks();
}

module.exports.todoistToTrello = (event, context, callback) => {
    todoistToTrello();
}

module.exports.trelloToTodoist = (event, context, callback) => {
    trelloToTodoist();
}

async function trelloToTodoist() {
    let todayList, doneList;

    let tasks = await getTodoistInboxTasks();

    let listsOnTrello = await getAllListsOnTrelloAsync(TODO_BOARD_ID);
    listsOnTrello.forEach((list) => {
        if (list.name.toLowerCase() === NAME_TODAY_COLUMN.toLowerCase()) {
            todayList = list;
        } else if (list.name.toLowerCase() === NAME_DONE_COLUMN.toLowerCase()) {
            doneList = list;
        }
    });

    let todayCards = await getAllCardsByBoardIdAsync(TODO_BOARD_ID);
    todayCards = todayCards.filter(card => card.idList === todayList.id);

    todayCards.forEach(card => {
        // card has not been copied to todoist
        if (card.idLabels.indexOf(TRELLO_TODOIST_LABEL) < 0) {
            const matchingTasks = tasks.filter(task => task.content === card.name && task.completed === false);
            if (!matchingTasks.length) {
                createTodoistTask({
                    content: card.name,
                    completed: false,
                    project_id: parseInt(TODOIST_INBOX_ID)
                });
            }
            card.idLabels.push(TRELLO_TODOIST_LABEL);
            updateCardLabels(card, card.idLabels);
        }
    });

    let doneCards = await getAllCardsByBoardIdAsync(TODO_BOARD_ID);
    doneCards = doneCards.filter(card => card.idList === doneList.id);

    doneCards.forEach(card => {
        // card has not been moved to done in todoist
        if (card.idLabels.indexOf(TRELLO_TODOIST_LABEL) > -1) {
            const matchingTasks = tasks.filter(task => task.content === card.name && task.completed === false);
            matchingTasks.forEach(completeTaskInTodoist);
            updateCardLabels(card, card.idLabels.filter(label => label !== TRELLO_TODOIST_LABEL));
        }
    });
}

function createTodoistTask(body) {
    return RP({
        method: 'POST',
        uri: `${TODOIST_API_URL}/tasks`,
        auth: {
            bearer: TODOIST_API_KEY
        },
        body,
        json: true
    })
    .catch(err => {
        console.log("Error in createTodoistTask", err.message);
    });;
}

function completeTaskInTodoist(task) {
    return RP(`${TODOIST_API_URL}/tasks/${task.id}`, {
        auth: {
            bearer: TODOIST_API_KEY
        },
        body: {
            content: task.content,
            completed: true
        },
        method: 'POST',
        json: true
    })
    .catch(err => {
        console.log("Error in completeTaskInTodoist", err.message);
    });;
}

function updateCardLabels(card, newLabels) {
    return RP({
        uri: `${TRELLO_API_URL}/cards/${card.id}?idLabels=${newLabels.join(',')}${TRELLO_API_AUTH}`,
        method: 'PUT',
        json: true
    })
    .catch(err => {
        console.log("Error in updateCardLabels", err.message);
    });;
}

async function todoistToTrello() {
    let todayList, doneList;

    let todoistSyncToken = await readFileAsync(TODOIST_SYNC_TOKEN_FILE).catch(() => {
        return '*';
    });

    let updates = await getTodoistTasksAsync(todoistSyncToken);
    let taskUpdates = updates.items.filter(item => item.project_id == TODOIST_INBOX_ID);

    if (taskUpdates.length) {
        let listsOnTrello = await getAllListsOnTrelloAsync(TODO_BOARD_ID);

        listsOnTrello.forEach((list) => {
            if (list.name.toLowerCase() === NAME_TODAY_COLUMN.toLowerCase()) {
                todayList = list;
            } else if (list.name.toLowerCase() === NAME_DONE_COLUMN.toLowerCase()) {
                doneList = list;
            }
        });

        let cards = await getAllCardsByBoardIdAsync(TODO_BOARD_ID);

        taskUpdates.forEach(task => {
            const matchingCards = cards.filter(card => {
                console.log(card.name, task.content)
                return card.name === task.content && card.idList === todayList.id
            });
            // TODO: remove from trello with is_deleted=1 or is_archived=1
            if (task.checked) {
                matchingCards.forEach(matchingCard => resetCardPosition(matchingCard, doneList));
            } else {
                if (!matchingCards.length) {
                    createTrelloCard(todayList, { name: task.content, labels: [TRELLO_TODOIST_LABEL] });
                }
            }
        });
    }

    todoistSyncToken = updates.sync_token;
    fs.writeFile(TODOIST_SYNC_TOKEN_FILE, todoistSyncToken, 'utf8', (err) => {
        if (err) console.log(err.message);
    });
}

async function readFileAsync(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err, result) => {
            if (err) {
                reject(err.message);
            } else {
                resolve(result);
            }
        })
    })
}

async function getTodoistInboxTasks(cb) {
    return RP({
        uri: `${TODOIST_API_URL}/tasks?project_id=${TODOIST_INBOX_ID}`,
        auth: {
            'bearer': TODOIST_API_KEY
        },
        json: true
    })
    .catch(err => {
        console.log("Error in getTodoistInboxTasks", err.message);
    });;
}

async function getTodoistTasksAsync(syncToken) {
    return RP({
        method: 'POST',
        uri: `${TODOIST_SYNC_API_URL}/sync`,
        formData: {
            token: TODOIST_API_KEY,
            sync_token: syncToken,
            resource_types: '["items"]'
        },
        json: true
    })
    .catch(err => {
        console.log("Error in getTodoistTasksAsync", err.message);
    });;
}

async function orderBoard(currentDay) {
    console.log("> Ordering board...");

    let listsOnTrello = await getAllListsOnTrelloAsync(MEAL_BOARD_ID);

    // Let's sort the array
    let foundCurrentDayInArray = false;

    while (foundCurrentDayInArray == false) {
        // If the first day of the week is the current one, yay!
        if (DAYS_OF_WEEK[0] == currentDay) {
            foundCurrentDayInArray = true;
        } else {
            DAYS_OF_WEEK.push(DAYS_OF_WEEK.shift());
        }
    }

    //
    // Find the highest position of list so that we can put them higher
    //
    let highestPos = Number.MIN_SAFE_INTEGER;

    listsOnTrello.forEach(function(list) {
        if (list.pos > highestPos) {
            highestPos = list.pos;
        }
    });

    // Order the lists on Trello
    for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
        // Loop over the lists on Trello
        listsOnTrello.forEach(function(trelloList) {
            if (trelloList.name.toLowerCase() == DAYS_OF_WEEK[i].toLowerCase()) {
                setPositionOfList(trelloList.id, parseInt((highestPos + 10) + i * 100));
            }
        });
    }
}

async function resetBoard() {
    console.log("> It's reset day!! Resetting...");

    let listsOnTrello = await getAllListsOnTrelloAsync(MEAL_BOARD_ID);

    let backLogColumn = null;

    while (backLogColumn === null) {
        // Take the first list
        let el = listsOnTrello.shift();

        if (el.name === NAME_BACKLOG_COLUMN) {
            backLogColumn = el;
        }
    }

    const cards = await getAllCardsOnTrelloAsync(MEAL_BOARD_ID);

    for (let card of cards) {
        await resetCardPosition(card, backLogColumn);
    };
}

async function resetCardPosition(card, backlogColumnObject) {
    console.log('--> Resetting card ' + card.id + ' to list' + backlogColumnObject.name + ' ' + backlogColumnObject.id);

    return RP({
        uri: `${TRELLO_API_URL}/cards/${card.id}/?idList=${backlogColumnObject.id}${TRELLO_API_AUTH}`,
        method: 'PUT'
    })
    .catch(err => {
        console.log("Error in resetCardPosition", err.message);
    });;
}

async function getAllCardsOnTrelloAsync(boardId) {
    return RP({
        uri: `${TRELLO_API_URL}/boards/${boardId}/cards?lists=open&cards=visible${TRELLO_API_AUTH}`,
        json: true
    })
    .catch(err => {
        console.log("Error in getAllCardsOnTrelloAsync", err.message);
    });;
}

async function getAllListsOnTrelloAsync(boardId) {
    return RP({
        uri: `${TRELLO_API_URL}/boards/${boardId}/lists?fields=name,pos${TRELLO_API_AUTH}`,
        json: true
    })
    .catch(err => {
        console.log("Error in getAllListsOnTrelloAsync", err.message);
    });;
}

async function setPositionOfList(listId, position) {
    console.log('--> Moving list ' + listId + ' to pos ' + position);

    return RP({
        uri: `${TRELLO_API_URL}/lists/${listId}/?pos=${position}${TRELLO_API_AUTH}`,
        method: 'PUT'
    })
    .catch(err => {
        console.error('Could not move list ' + listId + ' to pos ' + position, err.message);
    });
}

async function moveTomorrowToToday() {
  let listsOnTrello = await getAllListsOnTrelloAsync(TODO_BOARD_ID);
    
  let todayColumn = null, tomorrowColumn = null;

    while (todayColumn === null || tomorrowColumn === null) {
       let el = listsOnTrello.shift();

        if (el.name === NAME_TODAY_COLUMN) {
            todayColumn = el;
        } else if (el.name === NAME_TOMORROW_COLUMN) {
            tomorrowColumn = el;
        }
    }

    getAllCardsWithListId(TODO_BOARD_ID, function(cards) {
        cards.forEach((card) => {
            if (card.idList === tomorrowColumn.id) {
                // Moving card to today
                resetCardPosition(card, todayColumn);
            }
        });
    });
}

async function moveDue() {
    const today = new Date();
    let listsOnTrello = await getAllListsOnTrelloAsync(TODO_BOARD_ID);

    let todayColumn = null;
    let doneColumn = null;

    while (todayColumn === null) {
        // Take the first list
        let el = listsOnTrello.shift();

        if (el.name === NAME_TODAY_COLUMN) {
            todayColumn = el;
        }
    }

    while (doneColumn === null) {
        // Take the first list
        let el = listsOnTrello.shift();

        if (el.name === NAME_DONE_COLUMN) {
            doneColumn = el;
        }
    }

    const cards = await getAllDueCardsAsync(TODO_BOARD_ID);

    console.log("> Updating due cards");
    cards.forEach(function(card) {
        if (card.due !== null && card.idList !== doneColumn.id) {
            const due = new Date(card.due);
            if (due.toISOString().split('T')[0] === today.toISOString().split('T')[0]) {
                // Moving card to today
                resetCardPosition(card, todayColumn);
            }
        }
    });
}

async function getAllCardsByBoardIdAsync(boardId) {
    return RP({
        uri: `${TRELLO_API_URL}/boards/${boardId}/cards?field=name,idList${TRELLO_API_AUTH}`,
        json: true
    })
    .catch(err => {
        console.log("Error in getAllCardsByBoardIdAsync", err.message);
    });
}

function getAllCardsWithListId(boardId, callback) {
    return RP({
        uri: `${TRELLO_API_URL}/boards/${boardId}/cards?fields=name,idList${TRELLO_API_AUTH}`,
        json: true
    })
    .catch(err => {
        console.log("Error in getAllCardsWithListId", err.message);
    });
}

function getAllDueCardsAsync(boardId) {
    return RP({
        uri: `${TRELLO_API_URL}/boards/${boardId}/cards?fields=name,due,idList${TRELLO_API_AUTH}`,
        json: true
    })
    .catch(err => {
        console.log("Error in getAllDueCardsAsync", err.message);
    });
}

async function addRecurringTasks() {
    const tasks = JSON.parse(fs.readFileSync('recurring.json', 'utf8'));
    const cards = await getAllCardsOnTrelloAsync(TODO_BOARD_ID);
    const listsOnTrello = await getAllListsOnTrelloAsync(TODO_BOARD_ID);

    let todayColumn = null;
    let doneColumn = null;

    while (todayColumn === null) {
        // Take the first list
        let el = listsOnTrello.shift();

        if (el.name === NAME_TODAY_COLUMN) {
            todayColumn = el;
        }

        if (el.name === NAME_DONE_COLUMN) {
            doneColumn = el;
        }
    }

    tasks.forEach((task) => {
        if (!(cards.find((card) => card.name === task.name && card.idList !== doneColumn))) {
            if (task.daysOfWeek.length && task.daysOfWeek.indexOf(new Date().getDay()) > -1) {
                createTrelloCard(todayColumn, task);
            }
        }
    });
}

function createTrelloCard(list, task) {
    console.log(`--> Creating task "${task.name}"`);
    const labels = task.labels ? `&idLabels=${task.labels.join(',')}` : '';
    RP({
        uri: `${TRELLO_API_URL}/cards?name=${task.name}&idList=${list.id}${labels}${TRELLO_API_AUTH}`,
        method: 'POST',
        json: true
    })
    .catch(err => {
        console.log("Error in createTrelloCard", err.message);
    });;
}

require('make-runnable');

'use strict';

console.log('Loading function');

const REQUEST = require('request');

var config = require('yaml-env-config')('.');
for (let [key, val] of Object.entries(config.app.env_variables)) {
    process.env[key] = val;
}

//
// Configuration
//
const API_URL = 'https://api.trello.com/1';
const MEAL_BOARD_ID = process.env.TRELLO_MEAL_BOARD_ID;
const TODO_BOARD_ID = process.env.TRELLO_TODO_BOARD_ID;
const API_TOKEN = process.env.TRELLO_API_TOKEN;
const API_KEY = process.env.TRELLO_API_KEY;
const API_AUTH = '&key=' + API_KEY + '&token=' + API_TOKEN;
const RESET_DAY = 6; // Sunday
const NAME_BACKLOG_COLUMN = "Backlog";
const NAME_TODAY_COLUMN = "Today";
const NAME_TOMORROW_COLUMN = "Tomorrow";
const NAME_DONE_COLUMN = "Done";

let DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

module.exports.meal = (event, context, callback) => {

    // Get the current day
    const day = (new Date().getDay() + 6) % 7;
    const currentDay = DAYS_OF_WEEK[day];

    // Reset the board if it's the reset day
    if (day === RESET_DAY) {
        resetBoard(function() {
            orderBoard(currentDay);
        });
    } else {
        orderBoard(currentDay);
    }
}

module.exports.due = (event, context, callback) => {
    moveDue();
}

module.exports.tomorrow = (event, context, callback) => {
  moveTomorrowToToday();
}

function orderBoard(currentDay) {
    console.log("> Ordering board...");

    getAllListsOnTrello(MEAL_BOARD_ID, function(listsOnTrello) {
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
    });
}

function resetBoard(callback) {
    console.log("> It's reset day!! Resetting...");

    getAllListsOnTrello(MEAL_BOARD_ID, function(listsOnTrello) {
        let backLogColumn = null;

        while (backLogColumn === null) {
            // Take the first list
            let el = listsOnTrello.shift();

            if (el.name === NAME_BACKLOG_COLUMN) {
                backLogColumn = el;
            }
        }

        getAllCardsOnTrello(MEAL_BOARD_ID, function(cards) {
            cards.forEach(function(card) {
                resetCardPosition(card, backLogColumn);
            });

        });
    });

    callback();
}

function resetCardPosition(card, backlogColumnObject) {
    console.log('--> Resetting card ' + card.id + ' to list' + backlogColumnObject.name + ' ' + backlogColumnObject.id);

    REQUEST.put(API_URL + '/cards/' + card.id)
        .form({
            token: API_TOKEN,
            key: API_KEY,
            idList: backlogColumnObject.id,
        })
        .on('response', function(response) {
            if (response.statusCode != 200) {
                console.error('Could not move card ' + card.id + ' to pos 1');
            }
        });
}

function getAllCardsOnTrello(boardId, callback) {
    REQUEST(API_URL + '/boards/' + boardId + '?lists=open&cards=visible' + API_AUTH, function(error, response, body) {

        // Stop if there was an error
        if (error || response.statusCode != 200) {
            callback("Could not fetch an overview of the Trello board", null);
            return false;
        }

        callback(JSON.parse(body).cards);
    });
}

function getAllListsOnTrello(boardId, callback) {
    REQUEST(API_URL + '/boards/' + boardId + '/lists?fields=name,pos' + API_AUTH, function(error, response, body) {

        // Stop if there was an error
        if (error || response.statusCode != 200) {
            callback("Could not fetch an overview of the Trello board", null);
            return false;
        }

        callback(JSON.parse(body));
    });
}

function setPositionOfList(listId, position) {
    console.log('--> Moving list ' + listId + ' to pos ' + position);

    REQUEST.put(API_URL + '/lists/' + listId)
        .form({
            token: API_TOKEN,
            key: API_KEY,
            pos: position
        })
        .on('response', function(response) {
            if (response.statusCode != 200) {
                console.error('Could not move list ' + listId + ' to pos ' + position);
            }
        });
}

function moveTomorrowToToday() {
  getAllListsOnTrello(TODO_BOARD_ID, function(listsOnTrello) {
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
  });
}

function moveDue() {
    const today = new Date();
    getAllListsOnTrello(TODO_BOARD_ID, function(listsOnTrello) {
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

        getAllDueCards(TODO_BOARD_ID, function(cards) {
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
        });
    });
}

function getAllCardsWithListId(boardId, callback) {
    REQUEST(API_URL + '/boards/' + boardId + '/cards?fields=name,idList' + API_AUTH, function(error, response, body) {

        // Stop if there was an error
        if (error || response.statusCode != 200) {
            callback("Could not fetch Trello cards", null);
            return false;
        }

        callback(JSON.parse(body));
    });
}

function getAllDueCards(boardId, callback) {
    REQUEST(API_URL + '/boards/' + boardId + '/cards?fields=name,due,idList' + API_AUTH, function(error, response, body) {

        // Stop if there was an error
        if (error || response.statusCode != 200) {
            callback("Could not fetch Trello cards", null);
            return false;
        }

        callback(JSON.parse(body));
    });
}

require('make-runnable');
